/**
 * Minimal robots.txt reader (RFC 9309): groups by user agent, Allow/Disallow with
 * `*` and `$`, longest match wins, Allow wins a tie.
 */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = userAgent.toLowerCase().split('/')[0]!.trim();
  type Group = { agents: string[]; allow: string[]; disallow: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.allow.push(value);
    if (key === 'disallow' && value) current.disallow.push(value);
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
  };
}

function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path) ? body.length : -1;
}

/** Whether `pathWithQuery` (e.g. "/a/b?x=1") may be fetched under these rules. */
export function isAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  let best = -1;
  let allowed = true;
  for (const p of rules.disallow) {
    const n = matchLength(p, pathWithQuery);
    if (n > best) {
      best = n;
      allowed = false;
    }
  }
  for (const p of rules.allow) {
    const n = matchLength(p, pathWithQuery);
    if (n >= best && n >= 0) {
      best = n;
      allowed = true;
    }
  }
  return allowed;
}
