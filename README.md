# page-change-monitor

Watch public web pages for changes in their text, price or stock, on a schedule. Keeps one readable snapshot per page (so `git diff` shows what changed), applies rules such as "price dropped by 5%" or "no longer in stock", and alerts through a webhook, Slack or the GitHub Actions job summary. Runs as a CLI or as a GitHub Action in your own repository.

[![CI](https://github.com/quanticdata-io/page-change-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/quanticdata-io/page-change-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

- **Two kinds of target.** `text`: the page's main content as Markdown, diffed line by line, with CSS include/exclude rules and ignore patterns to cut noise. `fields`: named values read with CSS selectors (price, availability, rating...), compared with rules.
- **Snapshots made for git.** `snapshots/<target>.md` or `snapshots/<target>.json` with sorted keys, no timestamps: a scheduled commit appears only when a page changed.
- **Alerts where you look.** Generic JSON webhook, Slack-compatible incoming webhook, GitHub Actions job summary and step outputs, exit code 1 with `--fail-on-change`.
- **Two engines.** The [QuanticData](https://quanticdata.io/) scrape API (default; needs a key) or a local engine for simple static pages (no key; checks robots.txt).

Node.js 20 or later, no runtime dependencies.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Config file](#config-file)
- [Rules](#rules)
- [CLI](#cli)
- [GitHub Action](#github-action)
- [Notifications](#notifications)
- [Engines](#engines)
- [Limits](#limits)
- [Responsible use](#responsible-use)
- [Development](#development)

## Install

From source (the package is not published to npm):

```bash
git clone https://github.com/quanticdata-io/page-change-monitor
cd page-change-monitor
npm ci
npm run build
node dist/cli.js --help          # or: npm link, then page-change-monitor --help
```

## Quickstart

```bash
export QUANTICDATA_API_KEY=qd_live_your_key
node dist/cli.js --config examples/monitor.json
```

The first run saves a baseline:

```text
[baseline] Book price - A Light in the Attic https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html
[baseline] Quotes home page https://quotes.toscrape.com/

2 checked: 0 changed, 0 unchanged, 2 baseline, 0 error
```

and `snapshots/book-price-a-light-in-the-attic.json` holds the fields, as read from the live page:

```json
{
  "availability": "In stock (22 available)",
  "price": 51.77,
  "title": "A Light in the Attic"
}
```

Later runs compare with the snapshot. This is a real run after editing the stored price to 60 to simulate a price drop:

```text
[changed] Book price - A Light in the Attic https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html
  price dropped: 60 -> 51.77 (-13.7%)
  --- snapshots/book-price-a-light-in-the-attic.json (previous)
  +++ snapshots/book-price-a-light-in-the-attic.json (now)
  @@ -1,5 +1,5 @@
   {
     "availability": "In stock (22 available)",
  -  "price": 60,
  +  "price": 51.77,
     "title": "A Light in the Attic"
   }
```

No key? Text targets on simple static pages work with `--engine local`:

```bash
node dist/cli.js --config examples/monitor.json --engine local --only "Quotes home page"
```

## Config file

`monitor.json` (the path is set with `--config`):

```json
{
  "snapshots": "snapshots",
  "minIntervalSeconds": 5,
  "notify": { "webhook": "https://hooks.example.com/page-changes" },
  "targets": [
    {
      "name": "Book price - A Light in the Attic",
      "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
      "mode": "fields",
      "fields": {
        "title": "div.product_main h1",
        "price": { "selector": "div.product_main p.price_color", "fns": ["amount_from_string"] },
        "availability": "div.product_main p.availability"
      },
      "rules": [
        { "field": "price", "type": "decrease", "percent": 5 },
        { "field": "availability", "type": "not_contains", "value": "In stock" }
      ]
    },
    {
      "name": "Quotes home page",
      "url": "https://quotes.toscrape.com/",
      "parser": { "exclude": [".tags", ".tags-box", "footer"] },
      "ignore": ["[(]about[)]"]
    }
  ]
}
```

Top level:

| Key | Default | Meaning |
| --- | --- | --- |
| `targets` | required | Pages to watch (below) |
| `snapshots` | `"snapshots"` | Snapshot directory, relative to the current directory. `--snapshots` overrides it |
| `minIntervalSeconds` | `5` | Local engine: minimum seconds between two requests to the same host |
| `notify.webhook` | none | Generic JSON webhook URL. `MONITOR_WEBHOOK_URL` overrides it |
| `notify.slack` | none | Slack-compatible incoming webhook URL. `MONITOR_SLACK_WEBHOOK_URL` overrides it |

Each target:

| Key | Mode | Meaning |
| --- | --- | --- |
| `name` | both | Unique name; also the snapshot file name (`Book price!` becomes `book-price`) |
| `url` | both | `http` or `https` URL of a public page |
| `mode` | both | `text` (default) or `fields` (default when `fields` is given) |
| `contentMode` | both | Scrape API content scope: `smart` (default, page minus navigation, footer and cookie banners), `article` (main article only) or `full` |
| `parser.include` | both | CSS selectors: keep only these parts of the page (up to 25) |
| `parser.exclude` | both | CSS selectors: drop these parts, for example ads or "related items" (up to 25) |
| `ignore` | text | Regular expressions (JavaScript syntax, applied globally); matching text is removed before comparing, for example timestamps or view counters |
| `fields` | fields | The scrape API's `extract` schema: field name to CSS selector, or `{ "selector", "attr", "all", "fns" }` (`attr` reads an attribute, `all` returns every match, `fns` transforms the value, for example `["amount_from_string"]` for a number) |
| `rules` | fields | When to alert (next section). Without rules, any changed field alerts |
| `country` | both | Two-letter country code for the request's exit location (API engine only) |
| `render` | both | `true` forces a headless-browser render, `false` never renders (API engine only; default: the API decides) |

`parser`, `contentMode`, `fields`, `country` and `render` are sent to the API as documented for [`POST /scraper/extract`](https://quanticdata.io/docs/); the local engine ignores them.

## Rules

Rules apply to `fields` targets. Each rule names a field and a type; values like `"£51.77"` or `"1,299.00"` are read as numbers where a number is needed.

| Type | Extra keys | Alerts when |
| --- | --- | --- |
| `changed` | | The field's value differs from the snapshot |
| `decrease` | `percent` (default 0) | The number went down by at least `percent` % |
| `increase` | `percent` (default 0) | The number went up by at least `percent` % |
| `below` | `value` (number) | The number crosses below `value` (not on every run that stays below) |
| `above` | `value` (number) | The number crosses above `value` |
| `contains` | `value` (text) | The value starts to contain `value` (case-insensitive), for example "In stock" |
| `not_contains` | `value` (text) | The value stops containing `value` |

The snapshot is updated whenever a field changes, even when no rule fires, so `decrease` compares with the previous run.

## CLI

```text
page-change-monitor [run] [options]     check every target, update snapshots, notify
page-change-monitor validate [options]  check the config file and exit
```

| Option | Meaning |
| --- | --- |
| `-c, --config <file>` | Config file (default `monitor.json`) |
| `-s, --snapshots <dir>` | Snapshot directory (overrides `snapshots`) |
| `-e, --engine <name>` | `quanticdata` (default) or `local` |
| `--only <name>` | Check only this target; repeat for several |
| `--dry-run` | Compare but write no snapshots and send no notifications |
| `--fail-on-change` | Exit with code 1 when a target alerts |
| `--no-notify` | Do not call the webhooks |
| `--json` | Print the results as JSON |
| `-q, --quiet` | Do not print diffs |
| `--min-interval <s>` | Local engine: seconds between requests to one host (overrides `minIntervalSeconds`) |
| `-h, --help`, `-v, --version` | Help, version |

Environment variables:

| Variable | Meaning |
| --- | --- |
| `QUANTICDATA_API_KEY` | API key for the `quanticdata` engine ([create one](https://app.quanticdata.io/) on the API keys page) |
| `QUANTICDATA_API_BASE` | API base URL (default `https://api.quanticdata.io/v1`) |
| `MONITOR_WEBHOOK_URL` | Generic JSON webhook |
| `MONITOR_SLACK_WEBHOOK_URL` | Slack-compatible incoming webhook |

Exit codes: `0` done (including changes, unless `--fail-on-change`), `1` a target alerted with `--fail-on-change`, `2` usage or config error, `3` a target could not be checked or a notification failed (the other targets are still checked).

Each target ends in one status: `baseline` (first run, snapshot saved), `unchanged`, `changed` (snapshot updated; alerts listed when a rule fired) or `error` (fetch failed, the target answered 4xx/5xx or a block page, the text was empty, or no field matched; the snapshot is kept).

## GitHub Action

Run the monitor on a schedule in your own repository and commit the snapshots, so the repository history is the change history. Copy [`examples/github-actions/monitor.yml`](examples/github-actions/monitor.yml) to `.github/workflows/` next to your `monitor.json`, and add the secret `QUANTICDATA_API_KEY` (and optionally `MONITOR_SLACK_WEBHOOK_URL` or `MONITOR_WEBHOOK_URL`).

```yaml
- id: monitor
  uses: quanticdata-io/page-change-monitor@main
  with:
    config: monitor.json
    api-key: ${{ secrets.QUANTICDATA_API_KEY }}
    slack-webhook: ${{ secrets.MONITOR_SLACK_WEBHOOK_URL }}
```

The action builds the CLI from this repository's source on the runner (`npm ci && npm run build`), then runs it. Pin `@main` to a commit SHA if you want a fixed version; there are no release tags yet.

| Input | Default | Meaning |
| --- | --- | --- |
| `config` | `monitor.json` | Config file path in the workspace |
| `snapshots` | config value | Snapshot directory |
| `engine` | `quanticdata` | `quanticdata` or `local` |
| `api-key` | empty | QuanticData API key (from a secret) |
| `webhook` | empty | Generic JSON webhook URL (from a secret) |
| `slack-webhook` | empty | Slack-compatible webhook URL (from a secret) |
| `fail-on-change` | `false` | Fail the step when a target alerts |
| `args` | empty | Extra CLI options separated by spaces, for example `--quiet` |

| Output | Meaning |
| --- | --- |
| `changed` | `"true"` when at least one target alerted |
| `alerts` | Number of targets that alerted |
| `errors` | Number of targets that could not be checked |

The job summary shows a table of all targets and the diffs.

## Notifications

Webhooks are called once per run, only when at least one target alerted.

Generic webhook body (`POST`, `application/json`):

```json
{
  "source": "page-change-monitor",
  "version": "0.1.0",
  "checked_at": "2026-11-18T14:00:00.000Z",
  "changes": [
    {
      "name": "Book price - A Light in the Attic",
      "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
      "mode": "fields",
      "alerts": ["price dropped: 60 -> 51.77 (-13.7%)"],
      "diff": "--- snapshots/book-price-a-light-in-the-attic.json (previous)\n+++ ..."
    }
  ],
  "errors": []
}
```

Diffs longer than 10,000 characters are cut. The Slack body is `{"text": "..."}` with one block per changed page; any service that accepts that body works.

## Engines

### quanticdata (default)

Each target is one call to the QuanticData scrape endpoint, `POST https://api.quanticdata.io/v1/scraper/extract`, with `Authorization: Bearer $QUANTICDATA_API_KEY`. The request for a fields target:

```json
{
  "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
  "format": "markdown",
  "contentMode": "smart",
  "extract": {
    "price": { "selector": "div.product_main p.price_color", "fns": ["amount_from_string"] },
    "availability": "div.product_main p.availability"
  }
}
```

The fields of the response that the tool reads, from a real call (trimmed):

```json
{
  "type": "response",
  "message": "Extraction successful",
  "payload": {
    "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
    "finalUrl": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
    "status": 200,
    "title": "A Light in the Attic | Books to Scrape - Sandbox",
    "content": "...\n# A Light in the Attic\n\n£51.77\n\nIn stock (22 available)\n...",
    "data": { "price": 51.77, "availability": "In stock (22 available)" },
    "engine": "tls"
  }
}
```

- The API handles pages that need JavaScript (`render`) and serves requests from a chosen country (`country`).
- HTTP 429 is retried after `Retry-After` (up to 2 times, when the wait is at most 60 seconds). A 401 means the key is wrong, a 402 that the balance cannot cover the call.
- A `payload.blockReason`, or a target status of 400 or more, is reported as an error and never compared.
- Every check is a billed page; see [pricing](https://quanticdata.io/pricing/). The [API reference](https://quanticdata.io/docs/) documents which answers are not charged. A target checked every 6 hours is about 120 calls a month.

### local

```bash
node dist/cli.js --engine local
```

- Fetches each page directly with the User-Agent `page-change-monitor/0.1.0 (+https://github.com/quanticdata-io/page-change-monitor)`.
- Reads `robots.txt` once per site and skips disallowed URLs (a missing `robots.txt` allows everything; a server error disallows everything, as RFC 9309 says).
- Waits `minIntervalSeconds` (default 5) between requests to the same host.
- Reduces HTML to plain text (drops `head`, scripts, styles, `nav` and `footer`).
- Text targets only. No JavaScript, no CSS selectors, no `parser`, no `country`. Pages that build their content in the browser, or that refuse automated clients, will not work: use the API engine for those.

## Limits

- A text diff says which lines changed, not why. Pages with rotating content (dates, recommendations, counters) need `parser.exclude` or `ignore` patterns, or every run is a change.
- Selectors break when a site changes its markup. When no field matches, the target reports an error and keeps its last snapshot; update the selectors.
- Checks run one target at a time. The tool is meant for tens of pages, not thousands.
- GitHub may delay or skip scheduled workflow runs at busy times; do not rely on the Action for minute-level timing.

## Responsible use

- Watch public pages you are allowed to read, at a modest frequency, and respect each site's terms. The examples use public sample sites built for scraping practice.
- Do not use the tool to track individuals or to collect personal data.
- Snapshots copy page text into your repository: keep it private when the pages are not public, and mind copyright when you share snapshots.

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

The tests never call the QuanticData API or any website: the API client runs against recorded, trimmed responses in `test/fixtures/` through an injected `fetch`, and the local engine against an HTML fixture and mocked `robots.txt` answers. To run against the real API, set `QUANTICDATA_API_KEY` and run `node dist/cli.js --config examples/monitor.json --dry-run`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
