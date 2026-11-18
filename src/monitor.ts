import { type Config, type Target } from './config.js';
import { diffStats, unifiedDiff } from './diff.js';
import { type Engine } from './engines/types.js';
import { normalizeText, stableJson } from './normalize.js';
import { evaluateRules } from './rules.js';
import { SnapshotStore } from './snapshot.js';

export type Status = 'baseline' | 'unchanged' | 'changed' | 'error';

export interface TargetResult {
  name: string;
  url: string;
  mode: Target['mode'];
  status: Status;
  /** Human-readable reasons to notify. Empty when nothing should alert. */
  alerts: string[];
  /** Unified diff of the snapshot (text or JSON) when it changed. */
  diff?: string;
  error?: string;
  snapshot: string;
}

export interface RunOptions {
  engine: Engine;
  store?: SnapshotStore;
  /** Compare without writing snapshots. */
  dryRun?: boolean;
  /** Only targets whose name is in this list (case-insensitive). */
  only?: string[];
  onResult?: (r: TargetResult) => void;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

async function checkTarget(target: Target, engine: Engine, store: SnapshotStore, dryRun: boolean): Promise<TargetResult> {
  const base = { name: target.name, url: target.url, mode: target.mode, snapshot: store.path(target) };
  let page;
  try {
    page = await engine.fetchPage(target);
  } catch (e) {
    return { ...base, status: 'error', alerts: [], error: (e as Error).message };
  }

  let next: string;
  let data: Record<string, unknown> = {};
  if (target.mode === 'fields') {
    data = page.data ?? {};
    const names = Object.keys(target.fields ?? {});
    if (names.every((k) => isEmpty(data[k]))) {
      return { ...base, status: 'error', alerts: [], error: `No field matched on ${page.finalUrl}: check the CSS selectors (the snapshot was kept)` };
    }
    next = stableJson(Object.fromEntries(names.map((k) => [k, data[k] ?? null])));
  } else {
    next = normalizeText(page.content, target.ignore);
    if (next === '') {
      return { ...base, status: 'error', alerts: [], error: `The page text is empty on ${page.finalUrl} (the snapshot was kept)` };
    }
  }

  const prev = await store.read(target);
  if (prev === null) {
    if (!dryRun) await store.write(target, next);
    return { ...base, status: 'baseline', alerts: [] };
  }
  if (prev === next) return { ...base, status: 'unchanged', alerts: [] };

  const diff = unifiedDiff(prev, next, { fromLabel: `${base.snapshot} (previous)`, toLabel: `${base.snapshot} (now)` });
  let alerts: string[];
  if (target.mode === 'fields') {
    let before: Record<string, unknown> = {};
    try {
      before = JSON.parse(prev) as Record<string, unknown>;
    } catch {
      before = {};
    }
    alerts = evaluateRules(before, JSON.parse(next) as Record<string, unknown>, target.rules).map((a) => a.message);
  } else {
    const { added, removed } = diffStats(prev, next);
    alerts = [`Text changed: ${added} line${added === 1 ? '' : 's'} added, ${removed} removed`];
  }
  if (!dryRun) await store.write(target, next);
  return { ...base, status: 'changed', alerts, diff };
}

/** Checks every target in order and returns one result per target. */
export async function runMonitor(config: Config, opts: RunOptions): Promise<TargetResult[]> {
  const store = opts.store ?? new SnapshotStore(config.snapshots);
  const only = opts.only?.map((s) => s.toLowerCase());
  const targets = only ? config.targets.filter((t) => only.includes(t.name.toLowerCase())) : config.targets;
  const results: TargetResult[] = [];
  for (const target of targets) {
    const r = await checkTarget(target, opts.engine, store, opts.dryRun ?? false);
    results.push(r);
    opts.onResult?.(r);
  }
  return results;
}
