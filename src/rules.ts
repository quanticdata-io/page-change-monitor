import { type Rule } from './config.js';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface Alert {
  rule: Rule | null;
  field: string;
  message: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => (v === undefined || v === null ? '(empty)' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

/** Turns a value into a number: numbers as they are, strings such as "£51.77" or "1,299.00". */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const m = /-?\d[\d.,]*/.exec(v.replace(/\s/g, ''));
  if (!m) return null;
  let s = m[0];
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => !same(before[k], after[k])).map((field) => ({ field, before: before[field], after: after[field] }));
}

function fire(rule: Rule, before: unknown, after: unknown): string | null {
  const { field } = rule;
  switch (rule.type) {
    case 'changed':
      return same(before, after) ? null : `${field} changed: ${show(before)} -> ${show(after)}`;
    case 'decrease':
    case 'increase': {
      const a = toNumber(before);
      const b = toNumber(after);
      if (a === null || b === null || a === b) return null;
      if (rule.type === 'decrease' ? b > a : b < a) return null;
      const pct = a === 0 ? Infinity : (Math.abs(b - a) / Math.abs(a)) * 100;
      if (pct < (rule.percent ?? 0)) return null;
      const label = Number.isFinite(pct) ? ` (${rule.type === 'decrease' ? '-' : '+'}${pct.toFixed(1)}%)` : '';
      return `${field} ${rule.type === 'decrease' ? 'dropped' : 'rose'}: ${a} -> ${b}${label}`;
    }
    case 'below':
    case 'above': {
      const b = toNumber(after);
      const limit = rule.value as number;
      if (b === null) return null;
      const now = rule.type === 'below' ? b < limit : b > limit;
      const a = toNumber(before);
      const was = a === null ? false : rule.type === 'below' ? a < limit : a > limit;
      // Alert when the threshold is crossed, not on every run that stays past it.
      return now && !was ? `${field} is ${rule.type} ${limit}: ${b}` : null;
    }
    case 'contains':
    case 'not_contains': {
      const needle = String(rule.value).toLowerCase();
      const has = (v: unknown) => v !== undefined && v !== null && String(typeof v === 'string' ? v : JSON.stringify(v)).toLowerCase().includes(needle);
      const now = rule.type === 'contains' ? has(after) : !has(after);
      const was = rule.type === 'contains' ? has(before) : !has(before);
      return now && !was ? `${field} ${rule.type === 'contains' ? 'now contains' : 'no longer contains'} "${rule.value}": ${show(after)}` : null;
    }
  }
}

/**
 * Alerts for a fields target. Without rules, every changed field is an alert.
 * With rules, only rules that fire are alerts.
 */
export function evaluateRules(before: Record<string, unknown>, after: Record<string, unknown>, rules: Rule[] | undefined): Alert[] {
  if (!rules || rules.length === 0) {
    return changedFields(before, after).map((c) => ({ rule: null, field: c.field, message: `${c.field} changed: ${show(c.before)} -> ${show(c.after)}` }));
  }
  const alerts: Alert[] = [];
  for (const rule of rules) {
    const message = fire(rule, before[rule.field], after[rule.field]);
    if (message) alerts.push({ rule, field: rule.field, message });
  }
  return alerts;
}
