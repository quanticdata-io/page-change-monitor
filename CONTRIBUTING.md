# Contributing

Thanks for helping. Bug reports with the target that misbehaved (URL and config) are the most useful contribution.

## Setup

```bash
git clone https://github.com/quanticdata-io/page-change-monitor
cd page-change-monitor
npm ci
```

Node.js 20 or later.

## Checks

CI runs these on Node 20 and 22, on Ubuntu and Windows, plus an offline run of the composite action against a local page:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Ground rules

- Tests never call the QuanticData API or any website. Inject a `fetch` stand-in (`mockFetch` in `test/helpers.ts`) or a `FakeEngine`.
- API fixtures in `test/fixtures/` are responses recorded from the live API on 2026-11-18 and trimmed: no keys, no request ids, no personal data. Keep new ones the same way.
- The API client sends only fields documented in the [OpenAPI file](https://quanticdata.io/docs/openapi.json) for `POST /scraper/extract`. `buildRequest` in `src/engines/quanticdata.ts` is the one place that builds the body, and `test/engines.test.ts` pins it.
- Snapshot files are a public contract: their names and format decide what users see in git. Changing either is a breaking change.
- No runtime dependencies unless there is a strong reason.
- User-facing changes need a CHANGELOG entry under "Unreleased".

## Design notes

- Snapshots hold only the compared content (normalized Markdown, or sorted JSON), never a timestamp, so committing the directory on a schedule creates a commit only when a page changed.
- A fetch error, a block page, an empty page or selectors that match nothing are reported as errors and leave the snapshot untouched, so a broken run never looks like a change.
- The local engine is deliberately small: it fetches, checks robots.txt, waits between requests to one host and strips HTML to text. It does not run JavaScript and has no CSS extraction.
