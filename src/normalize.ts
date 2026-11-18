/**
 * Text as it is compared and stored: `ignore` patterns removed, trailing spaces and
 * runs of blank lines collapsed, one final newline.
 */
export function normalizeText(text: string, ignore: string[] = []): string {
  let s = text.replace(/\r\n/g, '\n');
  for (const pattern of ignore) s = s.replace(new RegExp(pattern, 'g'), '');
  s = s
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s === '' ? '' : s + '\n';
}

/** JSON with sorted keys, so field snapshots diff cleanly in git. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}
