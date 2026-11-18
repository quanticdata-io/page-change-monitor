import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { runMonitor } from '../src/monitor.js';
import { jobSummary, slackPayload, webhookPayload, writeGitHubActions } from '../src/notify.js';
import { SnapshotStore, slug } from '../src/snapshot.js';
import { FakeEngine, tempDir } from './helpers.js';

const config = (snapshots: string) =>
  parseConfig({
    snapshots,
    targets: [
      { name: 'Quotes home', url: 'https://quotes.toscrape.com/', ignore: ['Updated .*'] },
      {
        name: 'Book price',
        url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
        fields: { price: 'p.price_color', availability: 'p.availability' },
        rules: [{ field: 'price', type: 'decrease', percent: 10 }],
      },
    ],
  });

const pages = (text: string, price: number, availability = 'In stock (22 available)') =>
  new FakeEngine({
    'Quotes home': { content: text },
    'Book price': { content: 'ignored in fields mode', data: { price, availability } },
  });

describe('slug and SnapshotStore', () => {
  it('makes readable file names', () => {
    expect(slug('Book price: A Light in the Attic!')).toBe('book-price-a-light-in-the-attic');
    expect(slug('Crème brûlée')).toBe('creme-brulee');
    expect(slug('***')).toBe('target');
  });

  it('reads null before the first write', async () => {
    const store = new SnapshotStore(join(await tempDir(), 'nested', 'dir'));
    const t = config('x').targets[0]!;
    expect(await store.read(t)).toBeNull();
    await store.write(t, 'hello\n');
    expect(await store.read(t)).toBe('hello\n');
  });
});

describe('runMonitor', () => {
  it('records a baseline, then reports unchanged, then a change with a diff', async () => {
    const dir = await tempDir();
    const c = config(dir);

    const first = await runMonitor(c, { engine: pages('Quote one\nUpdated 10:00', 51.77) });
    expect(first.map((r) => r.status)).toEqual(['baseline', 'baseline']);
    expect((await readdir(dir)).sort()).toEqual(['book-price.json', 'quotes-home.md']);
    expect(await readFile(join(dir, 'quotes-home.md'), 'utf8')).toBe('Quote one\n');
    expect(JSON.parse(await readFile(join(dir, 'book-price.json'), 'utf8'))).toEqual({ availability: 'In stock (22 available)', price: 51.77 });

    // Only the ignored line differs: unchanged.
    const second = await runMonitor(c, { engine: pages('Quote one\nUpdated 16:00', 51.77) });
    expect(second.map((r) => r.status)).toEqual(['unchanged', 'unchanged']);

    const third = await runMonitor(c, { engine: pages('Quote one\nQuote two', 45) });
    const [text, fields] = third;
    expect(text!.status).toBe('changed');
    expect(text!.alerts).toEqual(['Text changed: 1 line added, 0 removed']);
    expect(text!.diff).toContain('+Quote two');
    expect(fields!.status).toBe('changed');
    expect(fields!.alerts).toEqual(['price dropped: 51.77 -> 45 (-13.1%)']);
    expect(fields!.diff).toContain('-  "price": 51.77');
    expect(fields!.diff).toContain('+  "price": 45');
    expect(await readFile(join(dir, 'quotes-home.md'), 'utf8')).toBe('Quote one\nQuote two\n');
  });

  it('a field change below the rule threshold updates the snapshot without alerting', async () => {
    const dir = await tempDir();
    const c = config(dir);
    await runMonitor(c, { engine: pages('a', 100) });
    const [, fields] = await runMonitor(c, { engine: pages('a', 95) });
    expect(fields!.status).toBe('changed');
    expect(fields!.alerts).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'book-price.json'), 'utf8')).price).toBe(95);
  });

  it('dry run compares without writing', async () => {
    const dir = await tempDir();
    const c = config(dir);
    await runMonitor(c, { engine: pages('a', 1), dryRun: true });
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps the snapshot on errors, empty text or unmatched selectors', async () => {
    const dir = await tempDir();
    const c = config(dir);
    await runMonitor(c, { engine: pages('stable text', 10) });
    const broken = new FakeEngine({ 'Quotes home': { content: '   \n' }, 'Book price': { content: '', data: { price: null, availability: '' } } });
    const results = await runMonitor(c, { engine: broken });
    expect(results.map((r) => r.status)).toEqual(['error', 'error']);
    expect(results[0]!.error).toContain('The page text is empty');
    expect(results[1]!.error).toContain('No field matched');
    expect(await readFile(join(dir, 'quotes-home.md'), 'utf8')).toBe('stable text\n');

    const failing = new FakeEngine({ 'Quotes home': new Error('QuanticData API answered 402'), 'Book price': { data: { price: 10, availability: 'x' } } });
    const [r] = await runMonitor(c, { engine: failing, only: ['quotes HOME'] });
    expect(r).toMatchObject({ status: 'error', error: 'QuanticData API answered 402' });
  });
});

describe('notifications', () => {
  const results = [
    { name: 'Book price', url: 'https://books.toscrape.com/x', mode: 'fields' as const, status: 'changed' as const, alerts: ['price dropped: 51.77 -> 45 (-13.1%)'], diff: '--- a\n+++ b\n', snapshot: 's/book-price.json' },
    { name: 'Quotes | home', url: 'https://quotes.toscrape.com/', mode: 'text' as const, status: 'unchanged' as const, alerts: [], snapshot: 's/quotes-home.md' },
    { name: 'Broken', url: 'https://quotes.toscrape.com/x', mode: 'text' as const, status: 'error' as const, alerts: [], error: 'HTTP 404', snapshot: 's/broken.md' },
  ];

  it('builds the generic webhook body', () => {
    expect(webhookPayload(results, '2026-11-18T14:00:00.000Z')).toEqual({
      source: 'page-change-monitor',
      version: '0.1.0',
      checked_at: '2026-11-18T14:00:00.000Z',
      changes: [{ name: 'Book price', url: 'https://books.toscrape.com/x', mode: 'fields', alerts: ['price dropped: 51.77 -> 45 (-13.1%)'], diff: '--- a\n+++ b\n' }],
      errors: [{ name: 'Broken', url: 'https://quotes.toscrape.com/x', error: 'HTTP 404' }],
    });
  });

  it('builds a Slack message', () => {
    expect(slackPayload(results)).toEqual({ text: 'page-change-monitor: 1 page changed\n\n*<https://books.toscrape.com/x|Book price>*\n- price dropped: 51.77 -> 45 (-13.1%)' });
  });

  it('writes a job summary table and Actions outputs', async () => {
    const md = jobSummary(results);
    expect(md).toContain('| [Book price](https://books.toscrape.com/x) | fields | changed | price dropped: 51.77 -> 45 (-13.1%) |');
    expect(md).toContain('| [Quotes \\| home](https://quotes.toscrape.com/) | text | unchanged |  |');
    expect(md).toContain('```diff\n--- a\n+++ b\n```');

    const dir = await tempDir();
    const summary = join(dir, 'summary.md');
    const output = join(dir, 'output.txt');
    await writeFile(summary, '');
    expect(await writeGitHubActions(results, {})).toBe(false);
    expect(await writeGitHubActions(results, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output })).toBe(true);
    expect(await readFile(summary, 'utf8')).toContain('## Page change monitor');
    expect(await readFile(output, 'utf8')).toBe('changed=true\nalerts=1\nerrors=1\n');
  });
});
