import { parseArgs } from 'node:util';
import { type Config, loadConfig } from './config.js';
import { LocalEngine } from './engines/local.js';
import { QuanticDataEngine } from './engines/quanticdata.js';
import { type Engine, type FetchLike } from './engines/types.js';
import { ConfigError } from './errors.js';
import { runMonitor, type TargetResult } from './monitor.js';
import { alerting, postJson, slackPayload, webhookPayload, writeGitHubActions } from './notify.js';
import { SnapshotStore } from './snapshot.js';
import { VERSION } from './version.js';

export const EXIT = { ok: 0, changed: 1, usage: 2, failed: 3 } as const;

export const HELP = `page-change-monitor ${VERSION}

Watch public web pages for changes and alert on them.

Usage:
  page-change-monitor [run] [options]     check every target, update snapshots, notify
  page-change-monitor validate [options]  check the config file and exit

Options:
  -c, --config <file>       Config file (default: monitor.json)
  -s, --snapshots <dir>     Snapshot directory (default: "snapshots" in the config, else ./snapshots)
  -e, --engine <name>       quanticdata (default) or local
      --only <name>         Check only this target; repeat for several
      --dry-run             Compare but do not write snapshots or send notifications
      --fail-on-change      Exit with code 1 when a target alerts
      --no-notify           Do not call the webhooks
      --json                Print the results as JSON instead of text
  -q, --quiet               Do not print diffs
      --min-interval <s>    Local engine: seconds between requests to one host (default 5)
  -h, --help                Show this help
  -v, --version             Show the version

Environment:
  QUANTICDATA_API_KEY        API key for the quanticdata engine
  QUANTICDATA_API_BASE       API base URL (default https://api.quanticdata.io/v1)
  MONITOR_WEBHOOK_URL        Generic JSON webhook (overrides notify.webhook)
  MONITOR_SLACK_WEBHOOK_URL  Slack-compatible incoming webhook (overrides notify.slack)

Exit codes: 0 done, 1 a target alerted (with --fail-on-change), 2 usage or config error,
3 a target or a notification failed.
`;

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Overrides engine construction (tests). */
  engine?: Engine;
  now?: () => Date;
}

function printResult(r: TargetResult, quiet: boolean, out: (s: string) => void): void {
  const head = `[${r.status}] ${r.name} ${r.url}`;
  out(head + '\n');
  if (r.error) out(`  ${r.error}\n`);
  for (const a of r.alerts) out(`  ${a}\n`);
  if (r.diff && !quiet) out(r.diff.replace(/^/gm, '  ') + '\n');
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c', default: 'monitor.json' },
        snapshots: { type: 'string', short: 's' },
        engine: { type: 'string', short: 'e', default: 'quanticdata' },
        only: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean', default: false },
        'fail-on-change': { type: 'boolean', default: false },
        'no-notify': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        'min-interval': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${HELP}`);
    return EXIT.usage;
  }
  const { values: o, positionals } = parsed;
  if (o.help) {
    out(HELP);
    return EXIT.ok;
  }
  if (o.version) {
    out(`${VERSION}\n`);
    return EXIT.ok;
  }
  const command = positionals[0] ?? 'run';
  if (!['run', 'validate'].includes(command) || positionals.length > 1) {
    err(`Unknown command: ${positionals.join(' ')}\n\n${HELP}`);
    return EXIT.usage;
  }

  let config: Config;
  try {
    config = await loadConfig(o.config);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`Config error: ${e.message}\n`);
      return EXIT.usage;
    }
    throw e;
  }
  if (command === 'validate') {
    out(`${o.config}: ${config.targets.length} target${config.targets.length === 1 ? '' : 's'}, valid\n`);
    return EXIT.ok;
  }

  const minInterval = o['min-interval'] !== undefined ? Number(o['min-interval']) : config.minIntervalSeconds;
  if (!Number.isFinite(minInterval) || minInterval < 0) {
    err('--min-interval must be a number of seconds >= 0\n');
    return EXIT.usage;
  }
  let engine: Engine;
  try {
    if (deps.engine) engine = deps.engine;
    else if (o.engine === 'local') engine = new LocalEngine({ fetch: deps.fetch, minIntervalSeconds: minInterval });
    else if (o.engine === 'quanticdata') engine = new QuanticDataEngine({ apiKey: env.QUANTICDATA_API_KEY ?? '', baseUrl: env.QUANTICDATA_API_BASE, fetch: deps.fetch });
    else {
      err(`--engine must be quanticdata or local, not ${o.engine}\n`);
      return EXIT.usage;
    }
  } catch (e) {
    err(`${(e as Error).message}\n`);
    return EXIT.usage;
  }

  if (o.only) {
    const names = new Set(config.targets.map((t) => t.name.toLowerCase()));
    const unknown = o.only.filter((n) => !names.has(n.toLowerCase()));
    if (unknown.length) {
      err(`Unknown target: ${unknown.join(', ')}\n`);
      return EXIT.usage;
    }
  }

  const store = new SnapshotStore(o.snapshots ?? config.snapshots);
  const results = await runMonitor(config, {
    engine,
    store,
    dryRun: o['dry-run'],
    only: o.only,
    onResult: o.json ? undefined : (r) => printResult(r, o.quiet, out),
  });
  if (o.json) out(JSON.stringify(results, null, 2) + '\n');

  let failed = results.some((r) => r.status === 'error');
  const alerts = alerting(results);
  if (!o.json) {
    const count = (s: string) => results.filter((r) => r.status === s).length;
    out(`\n${results.length} checked: ${count('changed')} changed, ${count('unchanged')} unchanged, ${count('baseline')} baseline, ${count('error')} error\n`);
  }

  if (alerts.length > 0 && !o['dry-run'] && !o['no-notify']) {
    const webhook = env.MONITOR_WEBHOOK_URL || config.notify.webhook;
    const slack = env.MONITOR_SLACK_WEBHOOK_URL || config.notify.slack;
    const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
    for (const [label, url, body] of [
      ['webhook', webhook, webhookPayload(results, checkedAt)],
      ['Slack webhook', slack, slackPayload(results)],
    ] as const) {
      if (!url) continue;
      try {
        await postJson(url, body, deps.fetch);
      } catch (e) {
        failed = true;
        err(`Could not notify the ${label}: ${(e as Error).message}\n`);
      }
    }
  }
  await writeGitHubActions(results, env);

  if (o['fail-on-change'] && alerts.length > 0) return EXIT.changed;
  return failed ? EXIT.failed : EXIT.ok;
}
