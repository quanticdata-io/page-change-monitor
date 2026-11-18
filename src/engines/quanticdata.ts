import { type Target } from '../config.js';
import { FetchError } from '../errors.js';
import { VERSION } from '../version.js';
import { type Engine, type FetchLike, type PageResult } from './types.js';

export const DEFAULT_API_BASE = 'https://api.quanticdata.io/v1';

export interface QuanticDataOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** How many times a 429 is retried after its Retry-After (default 2). */
  maxRetries?: number;
  /** Longest Retry-After the client waits for, in seconds (default 60). */
  maxRetryAfter?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ExtractPayload {
  url: string;
  finalUrl: string;
  status: number;
  title?: string | null;
  content: string;
  data?: Record<string, unknown>;
  blockReason?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Request body for POST /scraper/extract, built from documented fields only. */
export function buildRequest(target: Target): Record<string, unknown> {
  const body: Record<string, unknown> = {
    url: target.url,
    format: 'markdown',
    contentMode: target.contentMode ?? 'smart',
  };
  if (target.parser && (target.parser.include?.length || target.parser.exclude?.length)) body.parser = target.parser;
  if (target.mode === 'fields' && target.fields) body.extract = target.fields;
  if (target.country) body.country = target.country;
  if (target.render !== undefined) body.render = target.render;
  return body;
}

function apiMessage(status: number, body: unknown): string {
  const msg = typeof body === 'object' && body !== null && 'message' in body ? String((body as { message: unknown }).message) : '';
  const hint: Record<number, string> = {
    401: 'the API key is missing, wrong or disabled',
    402: 'the balance cannot cover this call',
    403: 'the account cannot serve this call',
    429: 'rate limited',
  };
  return [`QuanticData API answered ${status}`, hint[status], msg].filter(Boolean).join(': ');
}

/** Scrapes pages through the QuanticData scrape endpoint (POST /scraper/extract). */
export class QuanticDataEngine implements Engine {
  readonly name = 'quanticdata';
  private readonly base: string;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: QuanticDataOptions) {
    if (!opts.apiKey) throw new FetchError('QUANTICDATA_API_KEY is not set. Set it, or use --engine local for simple static pages.');
    this.base = (opts.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async fetchPage(target: Target): Promise<PageResult> {
    const maxRetries = this.opts.maxRetries ?? 2;
    const wait = this.opts.sleep ?? sleep;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.base}/scraper/extract`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          'user-agent': `page-change-monitor/${VERSION}`,
        },
        body: JSON.stringify(buildRequest(target)),
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.status === 429 && attempt < maxRetries) {
        const after = Number(res.headers.get('retry-after') ?? '5');
        const seconds = Number.isFinite(after) && after >= 0 ? after : 5;
        if (seconds <= (this.opts.maxRetryAfter ?? 60)) {
          await wait(seconds * 1000);
          continue;
        }
      }
      if (!res.ok) throw new FetchError(apiMessage(res.status, json), res.status);
      const payload = (json as { payload?: ExtractPayload } | null)?.payload;
      if (!payload || typeof payload.content !== 'string') throw new FetchError('Unexpected response from the QuanticData API: no payload.content');
      if (payload.blockReason) throw new FetchError(`The target answered with a block page (${payload.blockReason}); nothing was compared`, payload.status);
      if (payload.status >= 400) throw new FetchError(`The target answered HTTP ${payload.status}; nothing was compared`, payload.status);
      return {
        url: payload.url,
        finalUrl: payload.finalUrl,
        status: payload.status,
        title: payload.title ?? null,
        content: payload.content,
        ...(payload.data ? { data: payload.data } : {}),
      };
    }
  }
}
