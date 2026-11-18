import { describe, expect, it } from 'vitest';
import { parseConfig, type Target } from '../src/config.js';
import { LOCAL_USER_AGENT, LocalEngine } from '../src/engines/local.js';
import { buildRequest, QuanticDataEngine } from '../src/engines/quanticdata.js';
import { FetchError, RobotsDisallowedError } from '../src/errors.js';
import { htmlToText } from '../src/html-text.js';
import { isAllowed, parseRobots } from '../src/robots.js';
import { fixtureJson, fixtureText, json, mockFetch } from './helpers.js';

const BOOK = 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html';
const [textTarget, fieldsTarget] = parseConfig({
  targets: [
    { name: 'Book page', url: BOOK, parser: { exclude: ['.breadcrumb'] } },
    {
      name: 'Book price',
      url: BOOK,
      fields: { price: { selector: 'div.product_main p.price_color', fns: ['amount_from_string'] }, availability: 'div.product_main p.availability' },
      country: 'gb',
    },
  ],
}).targets as [Target, Target];

describe('buildRequest', () => {
  it('sends only documented fields of POST /scraper/extract', () => {
    expect(buildRequest(textTarget)).toEqual({ url: BOOK, format: 'markdown', contentMode: 'smart', parser: { exclude: ['.breadcrumb'] } });
    expect(buildRequest(fieldsTarget)).toEqual({
      url: BOOK,
      format: 'markdown',
      contentMode: 'smart',
      extract: fieldsTarget.fields,
      country: 'gb',
    });
  });
});

describe('QuanticDataEngine', () => {
  it('requires a key', () => {
    expect(() => new QuanticDataEngine({ apiKey: '' })).toThrow('QUANTICDATA_API_KEY is not set');
  });

  it('posts to /scraper/extract with a bearer key and reads the payload', async () => {
    const recorded = await fixtureJson('extract-fields.json');
    const m = mockFetch(() => json(recorded));
    const engine = new QuanticDataEngine({ apiKey: 'qd_test_key', fetch: m.fetch });
    const page = await engine.fetchPage(fieldsTarget);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toBe('https://api.quanticdata.io/v1/scraper/extract');
    const headers = m.calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer qd_test_key');
    expect(JSON.parse(String(m.calls[0]!.init!.body))).toEqual(buildRequest(fieldsTarget));
    expect(page).toMatchObject({ status: 200, title: 'A Light in the Attic | Books to Scrape - Sandbox', data: { price: 51.77, availability: 'In stock (22 available)' } });
    expect(page.content).toContain('# A Light in the Attic');
  });

  it('honours QUANTICDATA_API_BASE', async () => {
    const m = mockFetch(async () => json(await fixtureJson('extract-text.json')));
    await new QuanticDataEngine({ apiKey: 'k', baseUrl: 'http://127.0.0.1:4011/v1/', fetch: m.fetch }).fetchPage(textTarget);
    expect(m.calls[0]!.url).toBe('http://127.0.0.1:4011/v1/scraper/extract');
  });

  it('retries a 429 after Retry-After, then succeeds', async () => {
    const ok = await fixtureJson('extract-text.json');
    const limited = await fixtureJson('error-429.json');
    let n = 0;
    const m = mockFetch(() => (n++ === 0 ? json(limited, 429, { 'retry-after': '2' }) : json(ok)));
    const waits: number[] = [];
    const engine = new QuanticDataEngine({ apiKey: 'k', fetch: m.fetch, sleep: async (ms) => void waits.push(ms) });
    await engine.fetchPage(textTarget);
    expect(waits).toEqual([2000]);
    expect(m.calls).toHaveLength(2);
  });

  it('gives up on a long Retry-After', async () => {
    const m = mockFetch(async () => json(await fixtureJson('error-429.json'), 429, { 'retry-after': '1380' }));
    const engine = new QuanticDataEngine({ apiKey: 'k', fetch: m.fetch, sleep: async () => undefined });
    await expect(engine.fetchPage(textTarget)).rejects.toThrow('QuanticData API answered 429: rate limited: Rate limit exceeded');
    expect(m.calls).toHaveLength(1);
  });

  it('explains a 402', async () => {
    const m = mockFetch(async () => json(await fixtureJson('error-402.json'), 402));
    const err = await new QuanticDataEngine({ apiKey: 'k', fetch: m.fetch }).fetchPage(textTarget).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(402);
    expect((err as Error).message).toContain('the balance cannot cover this call');
  });

  it('treats a block page or a target error as an error, not as content', async () => {
    for (const [file, message] of [
      ['extract-blocked.json', 'block page (challenge)'],
      ['extract-404.json', 'The target answered HTTP 404'],
    ] as const) {
      const m = mockFetch(async () => json(await fixtureJson(file)));
      await expect(new QuanticDataEngine({ apiKey: 'k', fetch: m.fetch }).fetchPage(textTarget)).rejects.toThrow(message);
    }
  });

  it('rejects an unexpected body', async () => {
    const m = mockFetch(() => json({ type: 'response', message: 'ok', payload: {} }));
    await expect(new QuanticDataEngine({ apiKey: 'k', fetch: m.fetch }).fetchPage(textTarget)).rejects.toThrow('no payload.content');
  });
});

describe('robots.txt', () => {
  const robots = `# comment
User-agent: *
Disallow: /private/
Allow: /private/open$
Disallow: /*.pdf$

User-agent: page-change-monitor
User-agent: other-bot
Disallow: /no-monitors/
`;

  it('uses the group that names the tool, else the * group', () => {
    const mine = parseRobots(robots, LOCAL_USER_AGENT);
    expect(mine.disallow).toEqual(['/no-monitors/']);
    const generic = parseRobots(robots, 'SomethingElse/1.0');
    expect(generic.disallow).toEqual(['/private/', '/*.pdf$']);
  });

  it('applies longest match, Allow on ties, wildcards and anchors', () => {
    const r = parseRobots(robots, 'SomethingElse/1.0');
    expect(isAllowed(r, '/')).toBe(true);
    expect(isAllowed(r, '/private/x')).toBe(false);
    expect(isAllowed(r, '/private/open')).toBe(true);
    expect(isAllowed(r, '/private/open/more')).toBe(false);
    expect(isAllowed(r, '/files/a.pdf')).toBe(false);
    expect(isAllowed(r, '/files/a.pdf?x=1')).toBe(true);
    expect(isAllowed({ allow: [], disallow: [] }, '/anything')).toBe(true);
  });
});

describe('htmlToText', () => {
  it('keeps the text and drops head, scripts, styles, nav, footer and comments', async () => {
    const { title, text } = htmlToText(await fixtureText('books-page.html'));
    expect(title).toBe('A Light in the Attic | Books to Scrape - Sandbox');
    expect(text).toContain('A Light in the Attic\n£51.77\nIn stock (22 available)');
    expect(text).toContain("It's hard to imagine");
    expect(text).toContain('UPC\ta897fe39b1053632');
    for (const gone of ['var x', 'color:red', 'Home', 'Footer text', 'a comment']) expect(text).not.toContain(gone);
  });
});

describe('LocalEngine', () => {
  const page = async () => new Response(await fixtureText('books-page.html'), { headers: { 'content-type': 'text/html' } });

  it('checks robots.txt once per origin, identifies itself and spaces requests', async () => {
    const m = mockFetch(async (url) => (url.endsWith('/robots.txt') ? new Response('User-agent: *\nDisallow: /admin/\n') : page()));
    let clock = 0;
    const waits: number[] = [];
    const engine = new LocalEngine({
      fetch: m.fetch,
      minIntervalSeconds: 5,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const target: Target = { name: 'Book', url: BOOK, mode: 'text' };
    const result = await engine.fetchPage(target);
    await engine.fetchPage(target);
    expect(m.calls.map((c) => new URL(c.url).pathname)).toEqual(['/robots.txt', '/catalogue/a-light-in-the-attic_1000/index.html', '/catalogue/a-light-in-the-attic_1000/index.html']);
    expect((m.calls[1]!.init!.headers as Record<string, string>)['user-agent']).toBe(LOCAL_USER_AGENT);
    expect(waits).toEqual([5000, 5000]);
    expect(result.content).toContain('£51.77');
  });

  it('refuses a URL that robots.txt disallows', async () => {
    const m = mockFetch(() => new Response('User-agent: *\nDisallow: /catalogue/\n'));
    const engine = new LocalEngine({ fetch: m.fetch, minIntervalSeconds: 0 });
    await expect(engine.fetchPage({ name: 'Book', url: BOOK, mode: 'text' })).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(m.calls).toHaveLength(1);
  });

  it('treats a missing robots.txt as allowed and a server error as disallowed', async () => {
    const allowed = new LocalEngine({ fetch: mockFetch(async (u) => (u.endsWith('/robots.txt') ? new Response('', { status: 404 }) : page())).fetch, minIntervalSeconds: 0 });
    await expect(allowed.fetchPage({ name: 'Book', url: BOOK, mode: 'text' })).resolves.toMatchObject({ status: 200 });
    const blocked = new LocalEngine({ fetch: mockFetch(() => new Response('', { status: 503 })).fetch, minIntervalSeconds: 0 });
    await expect(blocked.fetchPage({ name: 'Book', url: BOOK, mode: 'text' })).rejects.toThrow('disallowed by robots.txt');
  });

  it('has no fields mode and reports HTTP errors', async () => {
    const engine = new LocalEngine({ fetch: mockFetch((u) => (u.endsWith('/robots.txt') ? new Response('') : new Response('gone', { status: 410 }))).fetch, minIntervalSeconds: 0 });
    await expect(engine.fetchPage(fieldsTarget)).rejects.toThrow('fields mode needs the quanticdata engine');
    await expect(engine.fetchPage({ name: 'Book', url: BOOK, mode: 'text' })).rejects.toThrow('HTTP 410');
  });
});
