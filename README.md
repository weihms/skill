---
name: api-monitor
description: Probe and monitor HTTP/HTTPS API endpoints and websites — status codes, latency (TTFB/p50/p95), response size, TLS certificate expiry, and response assertions (expected status, JSON paths, headers, body content, SLA thresholds). Writes an append-only JSONL history and diffs it against the previous run to report new failures, recoveries, consecutive-failure streaks and latency regressions. Use when the user asks whether an API or site is up or reachable, wants latency or uptime checked, needs to verify a deployed endpoint returns the right data, asks for a health check or smoke test of URLs, wants a monitoring report or trend, or wants recurring monitoring with alerts. Triggers include 接口监控, 健康检查, 巡检, 探活, 延迟排查, 证书到期, API 挂了, uptime check.
argument-hint: <url-or-config-path>
---

# API Monitor

## Overview

Zero-dependency Node scripts (18+) that probe endpoints, assert on responses,
and keep a history so regressions are visible as change rather than as a single
bad number.

All paths below are relative to the repo root; each skill lives in its own
top-level directory (this one is `api-monitor/`). Run the scripts — do not
read them into context to work out what they do.

## Supported target types

| target | support | notes |
| --- | --- | --- |
| REST / JSON API | full | any method, `json` path assertions, status/latency/header |
| HTML pages, static assets | full | `body_contains`, `content_type`, `cert_days_left`, size |
| GraphQL over HTTP | as JSON | `method: POST` with a query body, assert `json.data.*` / `json.errors` — no schema or introspection awareness |
| Authenticated endpoints | yes | `authorization` / `cookie` / API-key headers, values via `${VAR}` injection |
| Downloads, binary responses | partial | status, size, and timing measured; the payload is never parsed |
| XML / RSS / SOAP | full | `xml` path assertions, including attributes and repeated elements |
| Non-standard ports | yes | `https://host:8443/x` — the TLS probe follows the URL's port |
| gRPC | no | needs protobuf framing and HTTP/2 |
| WebSocket, SSE streams | no | one request/response only; no persistent connection or frame check |
| TCP port, database, queue health | no | HTTP(S) only |
| mTLS endpoints | no | client certificates and CA pinning are not configurable |
| JS-rendered SPA where content decides health | no | a `200` on the HTML shell proves the app works; use browser automation instead |

The XML reader is a pull parser built for monitoring, not a conforming XML
processor: no DTD validation, no external entities, no namespace resolution
(prefixes stay literal, so `soap:Envelope`), and no support for processing
instructions beyond skipping them. Well-formed HTML parses like XML, so a
`content_type` assertion still matters for pages served by mistake.

Scope limits: application-layer checks only. This is not a load generator
(`--samples` ≤ 20 exists to stabilise percentiles, not to stress a service), it
has one vantage point (this machine), it does not report HTTP version, does not
retry failures — a flaky result stays flaky, raise `--samples` instead of
masking it — and sends no outbound alert. Scheduled runs report back into the
conversation.

## Quick start

Ad-hoc, when the user names a URL:

```bash
node api-monitor/scripts/probe.mjs -u https://api.example.com/health --expect-status 200 --max-ms 800
```

Standing monitoring, from the template:

```bash
cp api-monitor/assets/endpoints.example.json ./api-monitor.config.json   # then edit the checks
node api-monitor/scripts/probe.mjs --samples 3
node api-monitor/scripts/report.mjs --alert
```

The example config runs green against public endpoints, so it doubles as a
self-test of the toolchain before pointing it at real targets.

## Workflow

1. **Establish the target set.** If the user gave URLs, use `--url`. Otherwise
   look for `api-monitor.config.json` or `.api-monitor/config.json` in the
   project; if absent, create one from `api-monitor/assets/endpoints.example.json` and fill
   in the endpoints you find (search the repo for base URLs, OpenAPI specs,
   route definitions, health endpoints).
   Before probing, check the target against the table above. An unsupported
   target is a false green: `GET /ws` returning `426 Upgrade Required` looks
   healthy to a status assertion but tells you nothing about the socket. Name
   the limit and what would actually cover it.
2. **Probe.** `node api-monitor/scripts/probe.mjs [flags]`. Exit `0` healthy, `1` failures,
   `2` bad usage or config. A `2` means fix the invocation, not the service.
3. **Interpret before reporting.** Distinguish transport errors
   (`ENOTFOUND`, `ECONNREFUSED`, timeout) from server responses (`500`, `429`,
   `403`) from assertion mismatches (right status, wrong payload). These have
   different causes and different fixes.
4. **Compare.** `node api-monitor/scripts/report.mjs` reads the history and reports what
   changed. One run alone cannot tell a regression from normal variance — always
   look at the trend when history exists. Latency is graded in two tiers: a p95
   rise of ≥50% and ≥100ms is noted as `slower`; ≥100% and ≥250ms is an alert
   that flips the exit code to 1. Below the alert tier is informational — do not
   present it as an incident.
5. **Only schedule on request.** See `api-monitor/references/scheduled-monitoring.md`, which
   covers the `qoder_cron` shapes, absolute-path requirement, and what to confirm
   with the user first.

## Commands

| task | command |
| --- | --- |
| probe a config | `node api-monitor/scripts/probe.mjs -c <config> --samples 3` |
| probe ad-hoc URLs | `node api-monitor/scripts/probe.mjs -u <url>[,<url2>] --expect-status 200 --max-ms 800` |
| one check only | `node api-monitor/scripts/probe.mjs -f <name-substring>` |
| machine-readable | `node api-monitor/scripts/probe.mjs --json` |
| no history write | `node api-monitor/scripts/probe.mjs --history off` |
| trend + diff | `node api-monitor/scripts/report.mjs --runs 20` |
| one-line alert | `node api-monitor/scripts/report.mjs --alert` |
| usage | `node api-monitor/scripts/probe.mjs --help` / `node api-monitor/scripts/report.mjs --help` |

`--samples N` repeats each check N times and reports p50/p95; use 2–3 for
latency claims, 1 when only reachability matters. `--concurrency` defaults to 4.

History defaults to `./.api-monitor/history.jsonl`, relative to the working
directory. Pass an absolute `--history` when the run may execute elsewhere.

## Adding or changing checks

`expect` supports `status` (number, list, or `"2xx"`), `max_ms`, `max_bytes`,
`content_type`, `header`, `body_contains`, `json` and `xml` (path → `exists` /
`absent` / `type:T` / `re:...` / literal), and `cert_days_left`. Mark
revenue-critical checks `"important": true` so they surface as `critical_failed`.

XML paths address attributes with `@` and element text with `#text`:
`Error.Code`, `rss.channel.item[1].guid`, `root.@total`,
`env:Envelope.env:Fault.faultcode`.

Full semantics, path syntax, per-sample rules, and `${VAR}` secret injection:
`api-monitor/references/config-schema.md`. Read it before writing a non-trivial config.

`name` is the history key. Renaming a check breaks its trend and registers as
config drift, so keep names stable and prefer editing the assertion over
renaming.

## Choosing thresholds

Set `max_ms` from observed behaviour, not from a guess: run `--samples 5`
first, then set the ceiling at roughly the p95 plus headroom. A threshold
tighter than the service's normal variance produces alerts nobody reads.

Third-party and public APIs are slow and rate-limited. Keep `--samples` ≤ 3 and
`--concurrency` ≤ 4 unless the user owns the service, and never loop a failing
probe to "see if it recovers".

## Guardrails

- **Monitoring must be read-only.** Only use `POST`/`PUT`/`DELETE` when the user
  explicitly supplies a safe test payload and confirms the endpoint is a test
  sink. A probe that creates records is an incident, not a monitor.
- **Never loosen an assertion to make a run pass.** If a check fails, report it.
  Changing `max_ms` or `status` to turn a red run green destroys the signal the
  user asked for. Threshold changes are the user's decision, proposed with the
  data that justifies them.
- **Secrets stay out of files and output.** Use `${VAR}` in headers rather than
  literal tokens; an unresolved variable is a hard error by design. Do not paste
  `authorization` values into your reply.
- **A failed probe from this machine is not proof of an outage.** Local DNS,
  VPN, proxy, or firewall produce the same `ENOTFOUND`/timeout as a dead
  service. Say what was observed and what would confirm it, and check whether
  other hosts fail the same way before declaring an incident.
- **Ask before scheduling.** Creating an automation is a persistent change to
  shared state. Confirm location, cadence, and the exact prompt first.

## Resources

- `api-monitor/scripts/probe.mjs` — probing, timing, TLS expiry, assertions, history write
- `api-monitor/scripts/report.mjs` — diff against previous run, trend table, p95 series, alert line
- `api-monitor/references/config-schema.md` — full config and assertion reference
- `api-monitor/references/scheduled-monitoring.md` — `qoder_cron` scheduling, alerting prompt template, history rotation
- `api-monitor/assets/endpoints.example.json` — working template covering every assertion type
