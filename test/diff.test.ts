import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, unifiedDiff } from '../src/diff.js';
import { normalizeText, stableJson } from '../src/normalize.js';

describe('diffLines', () => {
  it('produces a minimal edit script', () => {
    const edits = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect(edits.map((e) => e.op + e.line)).toEqual([' a', '-b', '+x', ' c', ' d', '+e']);
  });

  it('handles empty sides', () => {
    expect(diffLines([], ['a']).map((e) => e.op)).toEqual(['+']);
    expect(diffLines(['a'], []).map((e) => e.op)).toEqual(['-']);
    expect(diffLines([], [])).toEqual([]);
  });

  it('round-trips: applying the script rebuilds both sides', () => {
    const a = 'the quick brown fox jumps over the lazy dog'.split(' ');
    const b = 'a quick red fox jumped over the dog today'.split(' ');
    const edits = diffLines(a, b);
    expect(edits.filter((e) => e.op !== '+').map((e) => e.line)).toEqual(a);
    expect(edits.filter((e) => e.op !== '-').map((e) => e.line)).toEqual(b);
  });
});

describe('unifiedDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  it('writes diff -u style hunks with context', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const after = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10'].join('\n');
    expect(unifiedDiff(before, after, { fromLabel: 'a.md', toLabel: 'b.md' })).toBe(
      ['--- a.md', '+++ b.md', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8', ''].join('\n'),
    );
  });

  it('splits distant changes into separate hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const changed = [...lines];
    changed[1] = 'changed 2';
    changed[27] = 'changed 28';
    const d = unifiedDiff(lines.join('\n'), changed.join('\n'));
    expect(d.match(/^@@/gm)).toHaveLength(2);
    expect(d).toContain('@@ -1,5 +1,5 @@');
    expect(d).toContain('@@ -25,6 +25,6 @@');
  });

  it('counts added and removed lines', () => {
    expect(diffStats('a\nb\nc', 'a\nc\nd\ne')).toEqual({ added: 2, removed: 1 });
  });
});

describe('normalizeText', () => {
  it('drops ignored patterns, trailing spaces and extra blank lines', () => {
    expect(normalizeText('Price  \r\n\r\n\r\n\r\nUpdated 2026-11-18 10:00\nEnd', ['Updated \\S+ \\S+'])).toBe('Price\n\n\nEnd\n'.replace('\n\n\n', '\n\n'));
  });

  it('returns an empty string for blank text', () => {
    expect(normalizeText('  \n \n')).toBe('');
  });
});

describe('stableJson', () => {
  it('sorts keys at every level', () => {
    expect(stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
  });
});

describe('trailing newlines', () => {
  it('does not count the final newline as an empty line', () => {
    const d = unifiedDiff('{\n  "price": 60\n}\n', '{\n  "price": 51.77\n}\n');
    expect(d).toContain('@@ -1,3 +1,3 @@');
    expect(d.endsWith(' }\n')).toBe(true);
    expect(diffStats('a\n', 'a\nb\n')).toEqual({ added: 1, removed: 0 });
  });
});
