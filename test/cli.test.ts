import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, main } from '../src/cli.js';
import { VERSION } from '../src/version.js';
import { FakeEngine, fixtureJson, json, mockFetch, tempDir } from './helpers.js';

async function setup(extra: Record<string, unknown> = {}) {
  const dir = await tempDir();
  const configPath = join(dir, 'monitor.json');
  await writeFile(
    configPath,
    JSON.stringify({
      snapshots: join(dir, 'snapshots'),
      targets: [{ name: 'Book price', url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html', fields: { price: 'p.price_color' } }],
      ...extra,
    }),
  );
  return { dir, configPath };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  // env: {} keeps the real environment (CI variables, webhooks) out of the tests
  return { out, err, env: {} as NodeJS.ProcessEnv, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) };
}

const engineWith = (price: number) => new FakeEngine({ 'Book price': { content: '', data: { price } } });

describe('cli', () => {
  it('prints help and version', async () => {
    const o = io();
    expect(await main(['--help'], o)).toBe(EXIT.ok);
    expect(o.out.join('')).toContain('Usage:');
    expect(await main(['-v'], o)).toBe(EXIT.ok);
    expect(o.out.at(-1)).toBe(`${VERSION}\n`);
  });

  it('rejects unknown options, commands and engines', async () => {
    const { configPath } = await setup();
    const o = io();
    expect(await main(['--frobnicate'], o)).toBe(EXIT.usage);
    expect(await main(['watch', '-c', configPath], o)).toBe(EXIT.usage);
    expect(await main(['-c', configPath, '--engine', 'browser'], { ...o, env: {} })).toBe(EXIT.usage);
    expect(await main(['-c', configPath, '--only', 'nope'], { ...o, engine: engineWith(1) })).toBe(EXIT.usage);
  });

  it('validates a config', async () => {
    const { configPath } = await setup();
    const o = io();
    expect(await main(['validate', '-c', configPath], o)).toBe(EXIT.ok);
    expect(o.out.join('')).toContain('1 target, valid');
    expect(await main(['validate', '-c', join(configPath, '..', 'missing.json')], o)).toBe(EXIT.usage);
    expect(o.err.join('')).toContain('Config error');
  });

  it('needs an API key for the default engine', async () => {
    const { configPath } = await setup();
    const o = io();
    expect(await main(['-c', configPath], { ...o, env: {} })).toBe(EXIT.usage);
    expect(o.err.join('')).toContain('QUANTICDATA_API_KEY is not set');
  });

  it('runs end to end against the recorded API response', async () => {
    const { dir, configPath } = await setup();
    const recorded = await fixtureJson('extract-fields.json');
    const m = mockFetch(() => json(recorded));
    const o = io();
    const code = await main(['-c', configPath], { ...o, env: { QUANTICDATA_API_KEY: 'qd_test_key' }, fetch: m.fetch });
    expect(code).toBe(EXIT.ok);
    expect(o.out.join('')).toContain('[baseline] Book price');
    expect(JSON.parse(await readFile(join(dir, 'snapshots', 'book-price.json'), 'utf8'))).toEqual({ price: 51.77 });
  });

  it('alerts, notifies both webhooks, writes Actions output and fails on change', async () => {
    const { dir, configPath } = await setup({ notify: { webhook: 'https://hooks.example.com/json' } });
    const o = io();
    await main(['-c', configPath], { ...o, engine: engineWith(51.77) });

    const hooks = mockFetch(() => new Response('ok'));
    const output = join(dir, 'gh-output');
    const env = { MONITOR_SLACK_WEBHOOK_URL: 'https://hooks.example.com/slack', GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output };
    const code = await main(['-c', configPath, '--fail-on-change', '-q'], { ...o, env, engine: engineWith(45), fetch: hooks.fetch, now: () => new Date('2026-11-18T14:00:00Z') });
    expect(code).toBe(EXIT.changed);
    expect(hooks.calls.map((c) => c.url)).toEqual(['https://hooks.example.com/json', 'https://hooks.example.com/slack']);
    const body = JSON.parse(String(hooks.calls[0]!.init!.body));
    expect(body.changes[0].alerts).toEqual(['price changed: 51.77 -> 45']);
    expect(body.checked_at).toBe('2026-11-18T14:00:00.000Z');
    expect(JSON.parse(String(hooks.calls[1]!.init!.body)).text).toContain('Book price');
    expect(await readFile(output, 'utf8')).toBe('changed=true\nalerts=1\nerrors=0\n');
    expect(o.out.join('')).not.toContain('+  "price"');
  });

  it('dry run and --no-notify send nothing; --json prints results', async () => {
    const { configPath } = await setup({ notify: { webhook: 'https://hooks.example.com/json' } });
    const o = io();
    await main(['-c', configPath], { ...o, engine: engineWith(1) });
    const hooks = mockFetch(() => new Response('ok'));
    expect(await main(['-c', configPath, '--dry-run'], { ...o, env: {}, engine: engineWith(2), fetch: hooks.fetch })).toBe(EXIT.ok);
    expect(await main(['-c', configPath, '--no-notify', '--json'], { ...o, env: {}, engine: engineWith(2), fetch: hooks.fetch })).toBe(EXIT.ok);
    expect(hooks.calls).toHaveLength(0);
    const printed = JSON.parse(o.out.at(-1)!);
    expect(printed[0]).toMatchObject({ name: 'Book price', status: 'changed' });
  });

  it('exits 3 when a target or a webhook fails', async () => {
    const { configPath } = await setup({ notify: { webhook: 'https://hooks.example.com/json' } });
    const o = io();
    expect(await main(['-c', configPath], { ...o, env: {}, engine: new FakeEngine({ 'Book price': new Error('boom') }) })).toBe(EXIT.failed);
    await main(['-c', configPath], { ...o, env: {}, engine: engineWith(1) });
    const down = mockFetch(() => new Response('no', { status: 500 }));
    expect(await main(['-c', configPath], { ...o, env: {}, engine: engineWith(3), fetch: down.fetch })).toBe(EXIT.failed);
    expect(o.err.join('')).toContain('Could not notify the webhook: Webhook answered HTTP 500');
  });
});
