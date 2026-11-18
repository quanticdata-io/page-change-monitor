import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { tempDir } from './helpers.js';

const text = { name: 'Quotes home', url: 'https://quotes.toscrape.com/' };
const fields = {
  name: 'Book price',
  url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
  mode: 'fields',
  fields: { price: { selector: 'p.price_color', fns: ['amount_from_string'] }, availability: 'p.availability' },
  rules: [{ field: 'price', type: 'decrease', percent: 10 }],
};

describe('parseConfig', () => {
  it('applies defaults', () => {
    const c = parseConfig({ targets: [text] });
    expect(c.snapshots).toBe('snapshots');
    expect(c.minIntervalSeconds).toBe(5);
    expect(c.notify).toEqual({});
    expect(c.targets[0]).toEqual({ ...text, mode: 'text' });
  });

  it('infers fields mode from fields and keeps rules', () => {
    const noMode: Record<string, unknown> = { ...fields };
    delete noMode.mode;
    const c = parseConfig({ targets: [noMode] });
    expect(c.targets[0]!.mode).toBe('fields');
    expect(c.targets[0]!.rules).toEqual([{ field: 'price', type: 'decrease', percent: 10 }]);
  });

  it('accepts every documented target option', () => {
    const c = parseConfig({
      snapshots: '.monitor',
      minIntervalSeconds: 10,
      notify: { webhook: 'https://hooks.example.com/a', slack: 'https://hooks.example.com/b' },
      targets: [{ ...text, contentMode: 'article', parser: { include: ['main'], exclude: ['.ads'] }, ignore: ['\\d+ views'], country: 'US', render: false }],
    });
    expect(c.targets[0]).toMatchObject({ contentMode: 'article', parser: { include: ['main'], exclude: ['.ads'] }, ignore: ['\\d+ views'], country: 'us', render: false });
    expect(c.notify.slack).toBe('https://hooks.example.com/b');
  });

  it.each([
    [{}, 'targets must be a non-empty array'],
    [{ targets: [] }, 'targets must be a non-empty array'],
    [{ targets: [{ url: 'https://a.example' }] }, 'targets[0].name is required'],
    [{ targets: [{ name: 'a', url: 'ftp://a.example' }] }, 'must be http(s)'],
    [{ targets: [{ name: 'a', url: 'not a url' }] }, 'is not a valid URL'],
    [{ targets: [text, { ...text, name: 'QUOTES HOME' }] }, 'Duplicate target name'],
    [{ targets: [{ ...text, mode: 'pdf' }] }, 'mode must be'],
    [{ targets: [{ ...text, contentMode: 'everything' }] }, 'contentMode must be one of'],
    [{ targets: [{ ...text, ignore: ['('] }] }, 'invalid regular expression'],
    [{ targets: [{ ...text, country: 'usa' }] }, 'two-letter country code'],
    [{ targets: [{ ...text, rules: [] }] }, 'need "mode": "fields"'],
    [{ targets: [{ ...fields, fields: {} }] }, 'fields is required'],
    [{ targets: [{ ...fields, fields: { price: 3 } }] }, 'must be a CSS selector'],
    [{ targets: [{ ...fields, rules: [{ field: 'stock', type: 'changed' }] }] }, 'must name one of the fields'],
    [{ targets: [{ ...fields, rules: [{ field: 'price', type: 'jumps' }] }] }, 'type must be one of'],
    [{ targets: [{ ...fields, rules: [{ field: 'price', type: 'below' }] }] }, 'must be a number for "below"'],
    [{ targets: [{ ...fields, rules: [{ field: 'availability', type: 'contains', value: 1 }] }] }, 'must be a string for "contains"'],
    [{ targets: [{ ...fields, rules: [{ field: 'price', type: 'changed', percent: 5 }] }] }, 'percent applies only'],
    [{ targets: [{ ...text, parser: { include: Array(26).fill('p') } }] }, 'at most 25 selectors'],
    [{ targets: [text], notify: { webhook: 'nope' } }, 'notify.webhook is not a valid URL'],
    [{ targets: [text], minIntervalSeconds: -1 }, 'minIntervalSeconds'],
  ])('rejects %j', (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(message);
  });
});

describe('loadConfig', () => {
  it('reads a file', async () => {
    const dir = await tempDir();
    const file = join(dir, 'monitor.json');
    await writeFile(file, JSON.stringify({ targets: [text] }));
    expect((await loadConfig(file)).targets).toHaveLength(1);
  });

  it('reports missing files and bad JSON', async () => {
    const dir = await tempDir();
    await expect(loadConfig(join(dir, 'none.json'))).rejects.toThrow('Cannot read the config file');
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ targets: ');
    await expect(loadConfig(file)).rejects.toThrow('is not valid JSON');
  });

  it('validates the bundled example config', async () => {
    const c = await loadConfig(new URL('../examples/monitor.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    expect(c.targets.length).toBeGreaterThanOrEqual(2);
  });
});
