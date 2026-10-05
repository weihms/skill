# Scheduled monitoring and alerting

Periodic runs are scheduled through the `qoder_cron` tool
(`mcp__builtin__qoder_cron`), not through crontab. Each run is its own
conversation that executes a self-contained prompt.

## Before creating anything

Scheduling is a change to shared state, and the tool itself requires it: confirm
**location, schedule, prompt, and output mode** with the user first, and ask
whether they want local or cloud execution. Do not infer it, and do not silently
fall back to local if cloud fails.

Cloud runs do not inherit the local workspace, files, plugins, or permissions.
Since this skill's monitoring is `node <skill>/scripts/probe.mjs` reading a
config from disk, **local execution is the only option that works** unless the
config and scripts also exist in the cloud environment. Say so explicitly
rather than creating a local substitute for a cloud request.

## Paths must be absolute

An automation's working directory is not guaranteed to match the conversation
that created it. Always pass absolute paths for `--config` and `--history`,
otherwise each run starts a fresh empty history and every trend comparison is
lost:

```bash
node /abs/path/to/skill/scripts/probe.mjs \
  --config /abs/path/to/api-monitor.config.json \
  --history /abs/path/to/.api-monitor/history.jsonl \
  --samples 3
node /abs/path/to/skill/scripts/report.mjs \
  --history /abs/path/to/.api-monitor/history.jsonl --alert
```

Environment variables used by `${VAR}` substitution must be exported in the
automation's environment too. If they cannot be, replace the reference with a
check that does not need auth.

## Schedule shapes

| kind | use | fields |
| --- | --- | --- |
| `cron` | wall-clock cadence, e.g. weekdays 09:00 | `expression` (five fields: `0 9 * * 1-5`), `timeZone` (IANA, e.g. `Asia/Shanghai`) |
| `every` | fixed interval | `everyMs`, minimum 60000, maximum 31536000000 |
| `at` | one-shot, e.g. verify after a deploy | `at` (future ISO-8601 with `Z` or offset), plus `deleteAfterRun: true` to clean up |

Resolve the current time and the user's timezone before computing `at` or
`expiresAt`. Never infer a timezone from the language of the request. Cloud
tasks accept one-shot, intervals of at least 60 minutes, and five-field cron.

`outputMode`: `independent` gives each run a fresh conversation — right for
monitoring. `merged` keeps appending to one conversation and grows its context
forever; only use it when the user explicitly wants a running thread.

`executionAuthorization`: `true` is Full Access, `false` is Auto Approval.
Monitoring only runs local read-only network calls, so either is workable;
prefer `false` unless the run needs to write outside the workspace.

## Prompt template

The prompt is the whole job description — the run cannot see this conversation.
Fill in every placeholder before creating the task.

```
Run an HTTP API health check and report only if something is wrong.

1. Execute: node <ABS_SKILL_DIR>/scripts/probe.mjs --config <ABS_CONFIG> --history <ABS_HISTORY> --samples 3
2. Execute: node <ABS_SKILL_DIR>/scripts/report.mjs --history <ABS_HISTORY> --alert --runs 10

probe.mjs exits 0 when every check passes and 1 when any check fails.
If both exit 0, reply with exactly: "healthy — <N>/<N> checks passed".
Otherwise reply with an alert containing:
- the failing check names and their concrete failure reason from the report
- whether each is a NEW failure, still failing (and for how many consecutive runs), or recovered
- the p95 trend for each failing check from the P95 SERIES block
- certificates expiring within <N> days
- one suggested next diagnostic step per failing check

Do not retry more than once. Do not modify the config, the history file, or any
project files. Do not schedule further tasks. A single failed probe is not
proof of a production incident: if a failure looks like local network or DNS
trouble rather than a server response, say so instead of declaring an outage.
```

Keep `every` at 5 minutes or more unless the user asks for tighter polling —
each run costs a full conversation, and sub-minute polling mostly generates
duplicate alerts.

## Managing existing tasks

Call `action: "list"` first and use a returned `jobId`; never invent one.
`run` triggers immediate execution without waiting for it to finish. `update`
takes a partial `patch` — omitted fields keep their saved values, but a supplied
`schedule` replaces the entire schedule. Execution location cannot be changed
after creation; create a new task instead. `expiresAt` stops future scheduling,
and `patch.expiresAt: null` clears it.

## Reading alerts without crying wolf

- **New failure** — act. This is the transition.
- **Still failing, N runs in a row** — already known; escalate on the streak
  length, not on each run.
- **Flapping** (fails, recovers, fails) — usually a timeout that is too tight or
  a slow dependency. Raise `max_ms` or `timeout_ms` before treating it as an
  incident.
- **Latency regression with no failure** — compare against the P95 SERIES before
  reacting; a single slow sample is normal variance, three in a row is not.

## History growth

`history.jsonl` is append-only, one line per run. At one run every 5 minutes
that is roughly 105k lines a year. Trim it when the file gets large:

```bash
tail -n 2000 <ABS_HISTORY> > <ABS_HISTORY>.tmp && mv <ABS_HISTORY>.tmp <ABS_HISTORY>
```

`report.mjs` skips malformed lines and reports how many, so a partially written
line from an interrupted run does not break reporting.
