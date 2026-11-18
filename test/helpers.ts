import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Target } from '../src/config.js';
import { type Engine, type PageResult } from '../src/engines/types.js';

export const fixturePath = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

export async function fixtureJson<T = Record<string, unknown>>(name: string): Promise<T> {
  return JSON.parse(await readFile(fixturePath(name), 'utf8')) as T;
}

export async function fixtureText(name: string): Promise<string> {
  return readFile(fixturePath(name), 'utf8');
}

export const tempDir = () => mkdtemp(join(tmpdir(), 'pcm-'));

export interface Call {
  url: string;
  init?: RequestInit;
}

/** A fetch stand-in that records calls and answers from a list or a function. */
export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Engine that serves pages from a map keyed by target name. */
export class FakeEngine implements Engine {
  readonly name = 'fake';
  constructor(public pages: Record<string, Partial<PageResult> | Error>) {}
  async fetchPage(target: Target): Promise<PageResult> {
    const p = this.pages[target.name];
    if (!p) throw new Error(`no page for ${target.name}`);
    if (p instanceof Error) throw p;
    return { url: target.url, finalUrl: target.url, status: 200, title: null, content: '', ...p };
  }
}
