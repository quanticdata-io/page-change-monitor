import { readFile } from 'node:fs/promises';
import { ConfigError } from './errors.js';

export type ContentMode = 'smart' | 'article' | 'full';

/** A field of the scrape endpoint's `extract` schema: a CSS selector, or an object form. */
export type FieldSpec =
  | string
  | {
      selector: string;
      attr?: string;
      all?: boolean;
      fns?: unknown[];
    };

export type RuleType =
  | 'changed'
  | 'decrease'
  | 'increase'
  | 'below'
  | 'above'
  | 'contains'
  | 'not_contains';

export interface Rule {
  field: string;
  type: RuleType;
  /** Threshold for below/above, text for contains/not_contains. */
  value?: number | string;
  /** Minimum relative move for decrease/increase, in percent (default 0: any move). */
  percent?: number;
}

export interface Target {
  name: string;
  url: string;
  mode: 'text' | 'fields';
  /** Scrape API: content scope (text mode). */
  contentMode?: ContentMode;
  /** Scrape API: CSS selectors to keep only (`include`) or drop (`exclude`) parts of the page. */
  parser?: { include?: string[]; exclude?: string[] };
  /** Regular expressions; matching text is removed before comparing (dates, counters). */
  ignore?: string[];
  /** fields mode: the `extract` schema. */
  fields?: Record<string, FieldSpec>;
  /** fields mode: when to alert. Without rules, any field change alerts. */
  rules?: Rule[];
  country?: string;
  render?: boolean;
}

export interface Config {
  snapshots: string;
  minIntervalSeconds: number;
  notify: { webhook?: string; slack?: string };
  targets: Target[];
}

const RULE_TYPES: RuleType[] = ['changed', 'decrease', 'increase', 'below', 'above', 'contains', 'not_contains'];
const CONTENT_MODES: ContentMode[] = ['smart', 'article', 'full'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function stringArray(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new ConfigError(`${where} must be an array of strings`);
  return v as string[];
}

function httpUrl(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new ConfigError(`${where} must be a URL`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${where} is not a valid URL: ${v}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${where} must be http(s): ${v}`);
  return v;
}

function parseRule(raw: unknown, where: string, fields: Record<string, FieldSpec>): Rule {
  if (!isObject(raw)) throw new ConfigError(`${where} must be an object`);
  const { field, type, value, percent } = raw;
  if (typeof field !== 'string' || !(field in fields)) throw new ConfigError(`${where}.field must name one of the fields (${Object.keys(fields).join(', ')})`);
  if (typeof type !== 'string' || !RULE_TYPES.includes(type as RuleType)) throw new ConfigError(`${where}.type must be one of ${RULE_TYPES.join(', ')}`);
  const rule: Rule = { field, type: type as RuleType };
  if ((type === 'below' || type === 'above') && typeof value !== 'number') throw new ConfigError(`${where}.value must be a number for "${type}"`);
  if ((type === 'contains' || type === 'not_contains') && typeof value !== 'string') throw new ConfigError(`${where}.value must be a string for "${type}"`);
  if (value !== undefined) rule.value = value as number | string;
  if (percent !== undefined) {
    if (typeof percent !== 'number' || percent < 0) throw new ConfigError(`${where}.percent must be a number >= 0`);
    if (type !== 'decrease' && type !== 'increase') throw new ConfigError(`${where}.percent applies only to decrease and increase`);
    rule.percent = percent;
  }
  return rule;
}

function parseTarget(raw: unknown, i: number): Target {
  const where = `targets[${i}]`;
  if (!isObject(raw)) throw new ConfigError(`${where} must be an object`);
  if (typeof raw.name !== 'string' || raw.name.trim() === '') throw new ConfigError(`${where}.name is required`);
  const mode = raw.mode ?? (raw.fields ? 'fields' : 'text');
  if (mode !== 'text' && mode !== 'fields') throw new ConfigError(`${where}.mode must be "text" or "fields"`);
  const t: Target = { name: raw.name, url: httpUrl(raw.url, `${where}.url`), mode };

  if (raw.contentMode !== undefined) {
    if (!CONTENT_MODES.includes(raw.contentMode as ContentMode)) throw new ConfigError(`${where}.contentMode must be one of ${CONTENT_MODES.join(', ')}`);
    t.contentMode = raw.contentMode as ContentMode;
  }
  if (raw.parser !== undefined) {
    if (!isObject(raw.parser)) throw new ConfigError(`${where}.parser must be an object`);
    const include = stringArray(raw.parser.include, `${where}.parser.include`);
    const exclude = stringArray(raw.parser.exclude, `${where}.parser.exclude`);
    for (const list of [include, exclude]) if (list && list.length > 25) throw new ConfigError(`${where}.parser lists take at most 25 selectors`);
    t.parser = { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
  }
  const ignore = stringArray(raw.ignore, `${where}.ignore`);
  if (ignore) {
    for (const pattern of ignore) {
      try {
        new RegExp(pattern, 'g');
      } catch {
        throw new ConfigError(`${where}.ignore has an invalid regular expression: ${pattern}`);
      }
    }
    t.ignore = ignore;
  }
  if (raw.country !== undefined) {
    if (typeof raw.country !== 'string' || !/^[A-Za-z]{2}$/.test(raw.country)) throw new ConfigError(`${where}.country must be a two-letter country code`);
    t.country = raw.country.toLowerCase();
  }
  if (raw.render !== undefined) {
    if (typeof raw.render !== 'boolean') throw new ConfigError(`${where}.render must be true or false`);
    t.render = raw.render;
  }

  if (mode === 'fields') {
    if (!isObject(raw.fields) || Object.keys(raw.fields).length === 0) throw new ConfigError(`${where}.fields is required in fields mode`);
    for (const [k, spec] of Object.entries(raw.fields)) {
      const ok = typeof spec === 'string' || (isObject(spec) && typeof spec.selector === 'string');
      if (!ok) throw new ConfigError(`${where}.fields.${k} must be a CSS selector or { "selector": ... }`);
    }
    t.fields = raw.fields as Record<string, FieldSpec>;
    if (raw.rules !== undefined) {
      if (!Array.isArray(raw.rules)) throw new ConfigError(`${where}.rules must be an array`);
      t.rules = raw.rules.map((r, j) => parseRule(r, `${where}.rules[${j}]`, t.fields!));
    }
  } else if (raw.fields !== undefined || raw.rules !== undefined) {
    throw new ConfigError(`${where}: fields and rules need "mode": "fields"`);
  }
  return t;
}

/** Validates a parsed monitor.json. Throws ConfigError with the path of the first problem. */
export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigError('The config must be a JSON object');
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) throw new ConfigError('targets must be a non-empty array');
  const targets = raw.targets.map(parseTarget);
  const names = new Set<string>();
  for (const t of targets) {
    const key = t.name.toLowerCase();
    if (names.has(key)) throw new ConfigError(`Duplicate target name: ${t.name}`);
    names.add(key);
  }
  const notify: Config['notify'] = {};
  if (raw.notify !== undefined) {
    if (!isObject(raw.notify)) throw new ConfigError('notify must be an object');
    if (raw.notify.webhook !== undefined) notify.webhook = httpUrl(raw.notify.webhook, 'notify.webhook');
    if (raw.notify.slack !== undefined) notify.slack = httpUrl(raw.notify.slack, 'notify.slack');
  }
  const snapshots = raw.snapshots ?? 'snapshots';
  if (typeof snapshots !== 'string') throw new ConfigError('snapshots must be a directory path');
  const minIntervalSeconds = raw.minIntervalSeconds ?? 5;
  if (typeof minIntervalSeconds !== 'number' || minIntervalSeconds < 0) throw new ConfigError('minIntervalSeconds must be a number >= 0');
  return { snapshots, minIntervalSeconds, notify, targets };
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read the config file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}
