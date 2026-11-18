# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Email **hello@quanticdata.io** with the subject "Security: page-change-monitor" and include a description, steps to reproduce and the version you use. We acknowledge reports within 3 business days and keep you informed until a fix is released.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## API keys and webhook URLs

- The tool reads `QUANTICDATA_API_KEY` from the environment and sends it only in the `Authorization` header to the API base URL (`QUANTICDATA_API_BASE`, default `https://api.quanticdata.io/v1`). The local engine never sends it to the pages it fetches.
- Webhook URLs are secrets too (anyone with a Slack incoming webhook URL can post to your channel). Prefer `MONITOR_WEBHOOK_URL` and `MONITOR_SLACK_WEBHOOK_URL` from the environment or GitHub secrets over `notify` in a committed `monitor.json`.
- Snapshots contain the text of the pages you watch. Keep the snapshot directory in a private repository if those pages are not public.
- If a key leaks, rotate it on the API keys page of the QuanticData dashboard.
