export type Edit = { op: ' ' | '-' | '+'; line: string };

/** Line diff with the Myers O(ND) algorithm. */
export function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk the trace back to build the edit script.
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: ' ', line: a[--x]! });
      y--;
    }
    if (d > 0) {
      if (x === prevX) edits.push({ op: '+', line: b[--y]! });
      else edits.push({ op: '-', line: a[--x]! });
    }
  }
  return edits.reverse();
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  // A final newline ends the last line; it does not start an empty one.
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Unified diff (like `diff -u`) of two texts; empty string when they are equal. */
export function unifiedDiff(before: string, after: string, { context = 3, fromLabel = 'before', toLabel = 'after' } = {}): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const edits = diffLines(a, b);
  if (edits.every((e) => e.op === ' ')) return '';
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  // Positions of each edit in a and b.
  const pos: { ai: number; bi: number }[] = [];
  let ai = 0;
  let bi = 0;
  for (const e of edits) {
    pos.push({ ai, bi });
    if (e.op !== '+') ai++;
    if (e.op !== '-') bi++;
  }
  let i = 0;
  while (i < edits.length) {
    if (edits[i]!.op === ' ') {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while changes are within 2 * context lines of each other.
    for (let j = i; j < edits.length; j++) {
      if (edits[j]!.op !== ' ') end = j;
      else if (j - end > 2 * context) break;
    }
    const stop = Math.min(edits.length, end + context + 1);
    const hunk = edits.slice(start, stop);
    const aCount = hunk.filter((e) => e.op !== '+').length;
    const bCount = hunk.filter((e) => e.op !== '-').length;
    const aStart = aCount === 0 ? pos[start]!.ai : pos[start]!.ai + 1;
    const bStart = bCount === 0 ? pos[start]!.bi : pos[start]!.bi + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const e of hunk) out.push(e.op + e.line);
    i = stop;
    start = stop;
  }
  return out.join('\n') + '\n';
}

/** Counts of added and removed lines. */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  const edits = diffLines(splitLines(before), splitLines(after));
  return { added: edits.filter((e) => e.op === '+').length, removed: edits.filter((e) => e.op === '-').length };
}
