import { type Target } from '../config.js';
import { FetchError, RobotsDisallowedError } from '../errors.js';
import { htmlToText } from '../html-text.js';
import { isAllowed, parseRobots, type RobotsRules } from '../robots.js';
import { VERSION } from '../version.js';
import { type Engine, type FetchLike, type PageResult } from './types.js';

export const LOCAL_USER_AGENT = `page-change-monitor/${VERSION} (+https://github.com/quanticdata-io/page-change-monitor)`;

export interface LocalOptions {
  fetch?: FetchLike;
  /** Minimum seconds between two requests to the same host (default 5). */
  minIntervalSeconds?: number;
  userAgent?: string;
  /** Request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetches pages directly with an identifying User-Agent, after checking robots.txt,
 * and reduces the HTML to plain text. For simple static pages: no JavaScript, no
 * `fields` mode, no geo-targeting.
 */
export class LocalEngine implements Engine {
  readonly name = 'local';
  private readonly fetch: FetchLike;
  private readonly robots = new Map<string, RobotsRules>();
  private readonly lastHit = new Map<string, number>();
  private readonly ua: string;

  constructor(private readonly opts: LocalOptions = {}) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.ua = opts.userAgent ?? LOCAL_USER_AGENT;
  }

  private async get(url: URL): Promise<Response> {
    const host = url.host;
    const now = this.opts.now ?? Date.now;
    const minGap = (this.opts.minIntervalSeconds ?? 5) * 1000;
    const last = this.lastHit.get(host);
    if (last !== undefined) {
      const waitMs = last + minGap - now();
      if (waitMs > 0) await (this.opts.sleep ?? sleep)(waitMs);
    }
    this.lastHit.set(host, now());
    return this.fetch(url, {
      headers: { 'user-agent': this.ua, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
  }

  private async rulesFor(url: URL): Promise<RobotsRules> {
    const cached = this.robots.get(url.origin);
    if (cached) return cached;
    let rules: RobotsRules = { allow: [], disallow: [] };
    try {
      const res = await this.get(new URL('/robots.txt', url.origin));
      if (res.status >= 200 && res.status < 300) rules = parseRobots(await res.text(), this.ua);
      // RFC 9309: 4xx means no restrictions; a server error means assume full disallow.
      else if (res.status >= 500) rules = { allow: [], disallow: ['/'] };
    } catch {
      rules = { allow: [], disallow: ['/'] };
    }
    this.robots.set(url.origin, rules);
    return rules;
  }

  async fetchPage(target: Target): Promise<PageResult> {
    if (target.mode === 'fields') {
      throw new FetchError(`${target.name}: fields mode needs the quanticdata engine (the local engine has no CSS extraction)`);
    }
    const url = new URL(target.url);
    const rules = await this.rulesFor(url);
    if (!isAllowed(rules, url.pathname + url.search)) {
      throw new RobotsDisallowedError(`${target.url} is disallowed by robots.txt for ${this.ua.split(' ')[0]}`);
    }
    let res: Response;
    try {
      res = await this.get(url);
    } catch (e) {
      throw new FetchError(`Could not fetch ${target.url}: ${(e as Error).message}`);
    }
    if (res.status >= 400) throw new FetchError(`The target answered HTTP ${res.status}; nothing was compared`, res.status);
    const type = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const { title, text } = /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : { title: null, text: raw.trim() };
    return { url: target.url, finalUrl: res.url || target.url, status: res.status, title, content: text };
  }
}
