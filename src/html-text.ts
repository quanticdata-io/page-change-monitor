const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  pound: '£',
  euro: '€',
  copy: '©',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Plain text of an HTML page for change detection: drops scripts, styles, head,
 * navigation, footers and comments, keeps one line per block element. It is not a
 * readability extractor and does not run JavaScript.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|header|aside|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dd|dt|dl|form)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  s = decode(s)
    .split('\n')
    .map((line) => line.replace(/[ \f\v\u00a0]+/g, ' ').replace(/\t+/g, '\t').trim())
    .filter(Boolean)
    .join('\n');
  return { title: title ? decode(title).trim() : null, text: s };
}
