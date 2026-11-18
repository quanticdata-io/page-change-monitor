# Changelog

## Unreleased

## 0.1.0 (2026-11-18)

- `page-change-monitor` CLI: text targets (Markdown diff with parser include/exclude and ignore patterns) and fields targets (CSS `extract` schema with decrease, increase, below, above, contains, not_contains and changed rules).
- Snapshots as one readable file per target, without timestamps, for meaningful git diffs.
- Notifications: generic JSON webhook, Slack-compatible webhook, GitHub Actions job summary and outputs, exit codes.
- Engines: QuanticData scrape endpoint (default) and a local engine for static pages that checks robots.txt and spaces its requests.
- Composite GitHub Action and an example scheduled workflow that commits snapshots.
