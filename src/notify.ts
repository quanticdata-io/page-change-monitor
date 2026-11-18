import { appendFile } from 'node:fs/promises';
import { type FetchLike } from './engines/types.js';
import { type TargetResult } from './monitor.js';
import { VERSION } from './version.js';

const MAX_DIFF = 10_000;

const clip = (s: string | undefined, max = MAX_DIFF) => (s && s.length > max ? s.slice(0, max) + `\n... (${s.length - max} more characters)\n` : s);

export const alerting = (results: TargetResult[]) => results.filter((r) => r.alerts.length > 0);

/** JSON body for a generic webhook. */
export function webhookPayload(results: TargetResult[], checkedAt: string) {
  return {
    source: 'page-change-monitor',
    version: VERSION,
    checked_at: checkedAt,
    changes: alerting(results).map((r) => ({ name: r.name, url: r.url, mode: r.mode, alerts: r.alerts, diff: clip(r.diff) ?? null })),
    errors: results.filter((r) => r.status === 'error').map((r) => ({ name: r.name, url: r.url, error: r.error })),
  };
}

/** Body for a Slack-compatible incoming webhook (`text` with mrkdwn links). */
export function slackPayload(results: TargetResult[]) {
  const lines = alerting(results).map((r) => `*<${r.url}|${r.name}>*\n${r.alerts.map((a) => `- ${a}`).join('\n')}`);
  return { text: `page-change-monitor: ${lines.length} page${lines.length === 1 ? '' : 's'} changed\n\n${lines.join('\n\n')}` };
}

export async function postJson(url: string, body: unknown, fetchImpl: FetchLike = globalThis.fetch): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': `page-change-monitor/${VERSION}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Webhook answered HTTP ${res.status}`);
}

const STATUS_LABEL: Record<TargetResult['status'], string> = {
  baseline: 'baseline saved',
  unchanged: 'unchanged',
  changed: 'changed',
  error: 'error',
};

/** Markdown for the GitHub Actions job summary. */
export function jobSummary(results: TargetResult[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = results.map((r) => `| [${esc(r.name)}](${r.url}) | ${r.mode} | ${STATUS_LABEL[r.status]} | ${esc(r.error ?? r.alerts.join('; '))} |`);
  const diffs = results
    .filter((r) => r.diff)
    .map((r) => `<details><summary>${r.name}</summary>\n\n\`\`\`diff\n${clip(r.diff, 20_000)}\`\`\`\n\n</details>`);
  return ['## Page change monitor', '', '| Page | Mode | Status | Details |', '| --- | --- | --- | --- |', ...rows, '', ...diffs, ''].join('\n');
}

/** Writes the job summary and the `changed` / `alerts` / `errors` outputs when running in GitHub Actions. */
export async function writeGitHubActions(results: TargetResult[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.GITHUB_ACTIONS) return false;
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, jobSummary(results) + '\n', 'utf8');
  if (env.GITHUB_OUTPUT) {
    const n = alerting(results).length;
    const errors = results.filter((r) => r.status === 'error').length;
    await appendFile(env.GITHUB_OUTPUT, `changed=${n > 0}\nalerts=${n}\nerrors=${errors}\n`, 'utf8');
  }
  return true;
}
