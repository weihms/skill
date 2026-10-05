#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `Usage: node report.mjs [options]

Reads the JSONL history written by probe.mjs and reports health, changes since
the previous run, and latency trends.

Options:
      --history <path>   history file (default: ./.api-monitor/history.jsonl)
      --runs <n>         runs to show in the trend table, 1-200 (default: 10)
      --cert-days <n>    warn when a certificate expires within n days (default: 14)
      --alert            prefix a one-line summary meant for notifications
      --json             machine-readable analysis instead of the report
  -h, --help             this text

Exit codes: 0 healthy | 1 latest run has failures or a severe latency regression | 2 no usable history

Latency is graded in two tiers so normal variance does not page anyone:
  noted   p95 up >= 50% and >= 100ms  -> printed as "slower"
  alert   p95 up >= 100% and >= 250ms -> counts as unhealthy, exit 1, in --alert line`;

const BARS = '▁▂▃▄▅▆▇█';

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { history: null, runs: 10, certDays: 14, alert: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${a}\n\n${USAGE}`);
      return v;
    };
    const int = (raw, min, max) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) fail(`${a} expects an integer in ${min}..${max}, got "${raw}"`);
      return n;
    };
    switch (a) {
      case '--history': opts.history = next(); break;
      case '--runs': opts.runs = int(next(), 1, 200); break;
      case '--cert-days': opts.certDays = int(next(), 0, 3650); break;
      case '--alert': opts.alert = true; break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: fail(`unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return opts;
}

function loadHistory(path) {
  if (!existsSync(path)) fail(`no history at ${path}\n\nRun a probe first:\n  node <skill-dir>/scripts/probe.mjs --config <config>`);
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  const runs = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && Array.isArray(rec.checks)) runs.push(rec);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (!runs.length) fail(`${path} has ${lines.length} line(s) but no valid run records`);
  return { runs, skipped };
}

const byName = (run) => Object.fromEntries((run.checks || []).map((c) => [c.name, c]));

function streak(runs, name) {
  let n = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const c = byName(runs[i])[name];
    if (c && c.ok === false) n++;
    else break;
  }
  return n;
}

function bars(values) {
  const nums = values.filter((v) => typeof v === 'number');
  if (nums.length < 2) return '';
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  return values.map((v) => (typeof v === 'number' ? BARS[Math.min(7, Math.round(((v - min) / span) * 7))] : '·')).join('');
}

const pctChange = (from, to) => (typeof from === 'number' && typeof to === 'number' && from > 0 ? Math.round(((to - from) / from) * 100) : null);
const utc = (ts) => String(ts || '').slice(5, 16).replace('T', ' ');
// CJK characters occupy two terminal columns but one JS string unit.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const dw = (s) => [...String(s)].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (s, n) => { s = String(s); const w = dw(s); return w >= n ? s : s + ' '.repeat(n - w); };
const lpad = (s, n) => { s = String(s); const w = dw(s); return w >= n ? ' '.repeat(n - w) + s : s; };
function truncToWidth(s, n) {
  let out = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function analyze(runs, opts) {
  const last = runs[runs.length - 1];
  const prev = runs.length > 1 ? runs[runs.length - 2] : null;
  const lastMap = byName(last);
  const prevMap = prev ? byName(prev) : {};
  const failedNow = Object.values(lastMap).filter((c) => !c.ok);
  const failedBefore = Object.values(prevMap).filter((c) => !c.ok).map((c) => c.name);

  const newlyFailing = failedNow
    .filter((c) => prev && !failedBefore.includes(c.name))
    .map((c) => ({ name: c.name, url: c.url, status: c.status, p95_ms: c.p95_ms, prev_p95_ms: prevMap[c.name] ? prevMap[c.name].p95_ms : null, reasons: c.failures || [] }));
  const recovered = prev ? failedBefore.filter((n) => lastMap[n] && lastMap[n].ok) : [];
  const stillFailing = failedNow.filter((c) => failedBefore.includes(c.name)).map((c) => ({ name: c.name, runs: streak(runs, c.name), reasons: c.failures || [] }));

  const regressions = [];
  const improvements = [];
  if (prev) {
    for (const [name, c] of Object.entries(lastMap)) {
      const p = prevMap[name];
      if (!p || typeof c.p95_ms !== 'number' || typeof p.p95_ms !== 'number') continue;
      const change = pctChange(p.p95_ms, c.p95_ms);
      const delta = c.p95_ms - p.p95_ms;
      if (change === null || Math.abs(delta) < 100) continue;
      const entry = { name, from_ms: p.p95_ms, to_ms: c.p95_ms, change_pct: change };
      if (change >= 50) regressions.push({ ...entry, alert: change >= 100 && delta >= 250 });
      else if (change <= -50) improvements.push(entry);
    }
  }

  const certs = Object.values(lastMap)
    .filter((c) => typeof c.cert_days_left === 'number')
    .map((c) => ({ name: c.name, url: c.url, days_left: c.cert_days_left }))
    .filter((c) => c.days_left <= opts.certDays)
    .sort((a, b) => a.days_left - b.days_left);

  const lastNames = new Set(Object.keys(lastMap));
  const prevNames = new Set(Object.keys(prevMap));
  const added = prev ? [...lastNames].filter((n) => !prevNames.has(n)) : [];
  const removed = prev ? [...prevNames].filter((n) => !lastNames.has(n)) : [];

  const window = runs.slice(-opts.runs);
  const trend = window.map((run, i) => {
    const map = byName(run);
    const p95s = Object.values(map).map((c) => c.p95_ms).filter((v) => typeof v === 'number');
    const failed = Object.values(map).filter((c) => !c.ok).map((c) => c.name);
    return {
      run: runs.length - window.length + i + 1,
      ts: run.ts,
      passed: (run.summary && run.summary.passed) ?? Object.values(map).filter((c) => c.ok).length,
      total: (run.summary && run.summary.total) ?? Object.keys(map).length,
      fleet_p95_ms: p95s.length ? Math.max(...p95s) : null,
      failed,
    };
  });

  const series = {};
  for (const name of Object.keys(lastMap)) {
    series[name] = window.map((run) => {
      const c = byName(run)[name];
      return c ? c.p95_ms : null;
    });
  }

  const healthy = failedNow.length === 0 && !regressions.some((r) => r.alert);
  return {
    history_runs: runs.length,
    has_previous: !!prev,
    healthy,
    latest: {
      ts: last.ts,
      config: last.config,
      samples: last.samples,
      passed: last.summary ? last.summary.passed : Object.values(lastMap).filter((c) => c.ok).length,
      total: last.summary ? last.summary.total : Object.keys(lastMap).length,
      duration_ms: last.summary ? last.summary.duration_ms : null,
      critical_failed: last.summary ? last.summary.critical_failed : failedNow.filter((c) => c.important).length,
      failed: failedNow.map((c) => ({ name: c.name, url: c.url, status: c.status, p95_ms: c.p95_ms, reasons: c.failures || [] })),
    },
    changes: { newly_failing: newlyFailing, recovered, still_failing: stillFailing, latency_regressions: regressions, latency_improvements: improvements, checks_added: added, checks_removed: removed },
    cert_warnings: certs,
    trend,
    p95_series: series,
  };
}

function printReport(a, opts, meta) {
  const out = [];
  if (opts.alert) {
    const parts = [];
    if (a.changes.newly_failing.length) parts.push(`${a.changes.newly_failing.length} new failure(s): ${a.changes.newly_failing.map((f) => f.name).join(', ')}`);
    if (a.changes.still_failing.length) parts.push(`${a.changes.still_failing.length} still failing`);
    if (a.changes.latency_regressions.filter((r) => r.alert).length) parts.push(`${a.changes.latency_regressions.filter((r) => r.alert).length} severe latency regression(s): ${a.changes.latency_regressions.filter((r) => r.alert).map((r) => r.name).join(', ')}`);
    if (a.cert_warnings.length) parts.push(`cert expiring: ${a.cert_warnings.map((c) => `${new URL(c.url).hostname} ${c.days_left}d`).join(', ')}`);
    out.push(parts.length ? `ALERT api-monitor · ${a.latest.passed}/${a.latest.total} ok · ${parts.join(' · ')}` : `OK api-monitor · ${a.latest.passed}/${a.latest.total} checks healthy`);
    out.push('');
  }

  out.push(`api-monitor report · ${meta.path} · ${a.history_runs} run(s)${meta.skipped ? ` · ${meta.skipped} malformed line(s) skipped` : ''}`);
  out.push('');
  const l = a.latest;
  out.push(`LATEST  ${l.ts} · ${l.passed}/${l.total} passed${l.critical_failed ? ` · ${l.critical_failed} CRITICAL` : ''}${l.duration_ms ? ` · ${l.duration_ms}ms` : ''}${l.samples > 1 ? ` · ${l.samples} samples` : ''}`);
  if (l.failed.length) {
    for (const f of l.failed.slice(0, 20)) {
      out.push(`  FAIL ${f.name}  [status ${f.status || '-'} · p95 ${f.p95_ms ?? '-'}ms]`);
      (f.reasons || []).slice(0, 3).forEach((r) => out.push(`       └ ${String(r).slice(0, 150)}`));
    }
    if (l.failed.length > 20) out.push(`  … ${l.failed.length - 20} more failing check(s)`);
  } else {
    out.push('  all checks passed');
  }
  out.push('');

  const c = a.changes;
  const hasChanges = c.newly_failing.length || c.recovered.length || c.still_failing.length || c.latency_regressions.length || c.checks_added.length || c.checks_removed.length;
  out.push('CHANGES VS PREVIOUS RUN');
  if (!a.has_previous) out.push('  first run in history — nothing to compare against');
  else if (!hasChanges && !a.cert_warnings.length) out.push('  none');
  if (c.newly_failing.length) {
    out.push(`  new failures (${c.newly_failing.length}):`);
    c.newly_failing.forEach((f) => {
      const delta = f.prev_p95_ms && f.p95_ms && Math.abs(f.p95_ms - f.prev_p95_ms) >= 50 ? ` [p95 ${f.prev_p95_ms}ms → ${f.p95_ms}ms]` : '';
      out.push(`    · ${f.name}: ${(f.reasons[0] || 'unknown').slice(0, 120)}${delta}`);
    });
  }
  if (c.recovered.length) out.push(`  recovered (${c.recovered.length}): ${c.recovered.join(', ')}`);
  if (c.still_failing.length) c.still_failing.forEach((f) => out.push(`  still failing: ${f.name} [${f.runs} run(s) in a row] — ${(f.reasons[0] || '').slice(0, 100)}`));
  if (c.latency_regressions.length) c.latency_regressions.forEach((r) => out.push(`  slower${r.alert ? ' (ALERT)' : ''}: ${r.name} p95 ${r.from_ms}ms → ${r.to_ms}ms (+${r.change_pct}%)`));
  if (c.latency_improvements.length) c.latency_improvements.forEach((r) => out.push(`  faster: ${r.name} p95 ${r.from_ms}ms → ${r.to_ms}ms (${r.change_pct}%)`));
  if (c.checks_added.length) out.push(`  checks added: ${c.checks_added.join(', ')}`);
  if (c.checks_removed.length) out.push(`  checks removed: ${c.checks_removed.join(', ')}`);
  if (a.cert_warnings.length) a.cert_warnings.forEach((w) => out.push(`  cert: ${new URL(w.url).hostname} (${w.name}) expires in ${w.days_left}d`));
  out.push('');

  out.push(`TREND  last ${a.trend.length} run(s), time UTC`);
  out.push(`  ${lpad('#', 4)}  ${pad('TIME', 12)}  ${lpad('OK', 7)}  ${lpad('FLEET P95', 10)}  FAILED`);
  for (const t of a.trend) {
    const names = t.failed.join(', ');
    out.push(`  ${lpad(t.run, 4)}  ${pad(utc(t.ts), 12)}  ${lpad(`${t.passed}/${t.total}`, 7)}  ${lpad(t.fleet_p95_ms === null ? '-' : t.fleet_p95_ms + 'ms', 10)}  ${dw(names) > 70 ? truncToWidth(names, 70) : names || '-'}`);
  }
  out.push('');

  const interesting = new Set([...l.failed.map((f) => f.name), ...c.latency_regressions.map((r) => r.name)]);
  const names = interesting.size ? [...interesting] : Object.keys(a.p95_series).slice(0, 8);
  out.push(`P95 SERIES  last ${a.trend.length} run(s), ms${interesting.size ? ' (failing or regressed only)' : ''}`);
  const w = Math.min(30, Math.max(8, ...names.map((n) => dw(n))));
  for (const n of names) {
    const vals = a.p95_series[n] || [];
    const shown = vals.map((v) => (v === null || v === undefined ? '   -' : lpad(Math.round(v), 4)));
    out.push(`  ${pad(dw(n) > w ? truncToWidth(n, w) : n, w)}  ${shown.join(' ')}  ${bars(vals)}`);
  }
  console.log(out.join('\n'));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const path = resolve(opts.history || '.api-monitor/history.jsonl');
  const { runs, skipped } = loadHistory(path);
  const a = analyze(runs, opts);
  if (opts.json) console.log(JSON.stringify({ history: path, skipped_lines: skipped, analysis: a }, null, 2));
  else printReport(a, opts, { path, skipped });
  process.exit(a.healthy ? 0 : 1);
}

try {
  main();
} catch (e) {
  fail(`report.mjs crashed: ${(e && e.message) || e}`);
}
