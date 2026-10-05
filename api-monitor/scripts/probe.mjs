#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import tls from 'node:tls';

const USAGE = `Usage: node probe.mjs [options]

Probe either a config file of named checks, or ad-hoc URLs.

Options:
  -c, --config <path>   config file (default: ./api-monitor.config.json or ./.api-monitor/config.json)
  -u, --url <url>       ad-hoc target, repeatable or comma-separated; replaces --config
      --expect-status   ad-hoc expectation: 200 | 200,204 | 2xx (default: any completed response)
      --max-ms <n>      ad-hoc latency ceiling in ms
      --samples <n>     requests per check, 1-20 (default: 1)
      --concurrency <n> checks in flight, 1-32 (default: 4)
      --timeout <ms>    per-request timeout, 500-600000 (default: 10000)
      --history <path>  append run record (default: ./.api-monitor/history.jsonl; "off" disables)
  -f, --filter <sub>    only run checks whose name contains <sub>
      --json            machine-readable results instead of the table
  -h, --help            this text

Examples:
  node probe.mjs -u https://api.example.com/health --expect-status 200 --max-ms 800
  node probe.mjs --config api-monitor.config.json --samples 3
  node probe.mjs -f orders --json

Exit codes: 0 all checks passed | 1 one or more checks failed | 2 bad usage or config`;

const MAX_ROWS = 60;
const MAX_DETAIL_PER_CHECK = 4;
const MAX_DETAIL_LINES = 100;
const MAX_DEPTH = 100;

if (typeof fetch !== 'function') {
  console.error('probe.mjs needs Node.js 18+ for global fetch (found ' + process.version + ')');
  process.exit(2);
}

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function intArg(raw, flag, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${flag} expects an integer in ${min}..${max}, got "${raw}"`);
  return n;
}

function parseArgs(argv) {
  const opts = { config: null, urls: [], expectStatus: null, maxMs: null, samples: 1, concurrency: 4, timeout: 10000, history: null, filter: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${a}\n\n${USAGE}`);
      return v;
    };
    switch (a) {
      case '-c': case '--config': opts.config = next(); break;
      case '-u': case '--url': opts.urls.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--expect-status': opts.expectStatus = parseStatusArg(next()); break;
      case '--max-ms': opts.maxMs = intArg(next(), a, 1, 3600000); break;
      case '--samples': opts.samples = intArg(next(), a, 1, 20); break;
      case '--concurrency': opts.concurrency = intArg(next(), a, 1, 32); break;
      case '--timeout': opts.timeout = intArg(next(), a, 500, 600000); break;
      case '--history': {
        const v = next();
        opts.history = v === 'off' ? 'off' : v;
        break;
      }
      case '-f': case '--filter': opts.filter = next(); break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: fail(`unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  if (opts.urls.length && opts.config) fail(`--url and --config cannot be combined — put the URLs in the config, or drop --config`);
  if (!opts.urls.length && (opts.expectStatus !== null || opts.maxMs !== null)) fail(`--expect-status and --max-ms only apply to --url targets; for a config, set them under each check's "expect"`);
  return opts;
}

function parseStatusArg(raw) {
  if (/^[1-5]xx$/i.test(raw.trim())) return raw.trim().toLowerCase();
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 100 || n > 599) fail(`--expect-status expects 100-599 or "2xx", got "${s}"`);
    return n;
  });
  if (!list.length) fail('--expect-status needs at least one status');
  return list.length === 1 ? list[0] : list;
}

function nameFromUrl(raw, taken) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`--url expects a full URL including http(s)://, got "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`--url only supports http(s), got "${u.protocol}" for ${raw}`);
  const path = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\/+/g, ' ');
  let name = `${u.hostname.replace(/^www\./, '')}${path ? ' ' + path : ''}`.trim();
  if (name.length > 40) name = name.slice(0, 39) + '…';
  let candidate = name;
  let i = 2;
  while (taken.has(candidate)) candidate = `${name} (${i++})`;
  taken.add(candidate);
  return candidate;
}

function adHocConfig(opts) {
  const taken = new Set();
  const expect = {};
  if (opts.expectStatus !== null) expect.status = opts.expectStatus;
  if (opts.maxMs !== null) expect.max_ms = opts.maxMs;
  return {
    path: '(ad-hoc --url)',
    defaults: {},
    checks: opts.urls.map((url) => ({ name: nameFromUrl(url, taken), url, expect })),
  };
}

function expandEnv(value, missing) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
      const v = process.env[name];
      if (v === undefined) missing.add(name);
      return v === undefined ? m : v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, missing));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, missing);
    return out;
  }
  return value;
}

const CANDIDATES = ['api-monitor.config.json', '.api-monitor/config.json'];

function loadConfig(explicit) {
  const path = explicit ? resolve(explicit) : CANDIDATES.map((p) => resolve(p)).find((p) => existsSync(p));
  if (!path) fail(`no config found. Looked for:\n  ${CANDIDATES.join('\n  ')}\n\nCreate one from the skill template:\n  cp <skill-dir>/assets/endpoints.example.json api-monitor.config.json`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${path}: cannot read config — ${e.message.split('\n')[0]}`);
  }
  const missingVars = new Set();
  cfg = expandEnv(cfg, missingVars);
  if (missingVars.size) fail(`${path}: unresolved environment variable(s): ${[...missingVars].join(', ')}\nExport them before running, or remove the \${...} reference from the config.`);
  if (!cfg || !Array.isArray(cfg.checks) || cfg.checks.length === 0) fail(`${path}: config must have a non-empty "checks" array`);
  const seen = new Set();
  cfg.checks.forEach((c, i) => {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) fail(`${path}: checks[${i}] needs a non-empty "name"`);
    if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) fail(`${path}: check "${c.name}" needs an http(s) "url"`);
    if (seen.has(c.name)) fail(`${path}: duplicate check name "${c.name}" — names are the history key`);
    seen.add(c.name);
  });
  return { path, defaults: cfg.defaults || {}, checks: cfg.checks };
}

const r1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

function short(v, n = 70) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

function pct(values, p) {
  const nums = values.filter((v) => typeof v === 'number');
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return r1(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]);
}

const NET_ERRORS = {
  ENOTFOUND: 'DNS resolution failed',
  EAI_AGAIN: 'DNS temporarily unavailable',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset by peer',
  EPIPE: 'connection closed by peer',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ETIMEDOUT: 'connect timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connect timed out',
  UND_ERR_HEADERS_TIMEOUT: 'server sent no headers in time',
  UND_ERR_BODY_TIMEOUT: 'server sent no body in time',
  UND_ERR_SOCKET: 'socket error',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS chain incomplete (missing intermediate)',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in chain',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificate hostname mismatch',
  CERT_HAS_EXPIRED: 'certificate expired',
};

function explainNet(err, timeout) {
  if (err && err.name === 'TimeoutError') return `timeout after ${timeout}ms (no response headers)`;
  const cause = (err && err.cause) || null;
  const code = cause && (cause.code || cause.errno);
  if (code) return NET_ERRORS[code] ? `${code}: ${NET_ERRORS[code]}` : String(code);
  if (cause && cause.message) return cause.message;
  return `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`;
}

function oneAttempt(check, defaults, timeout, maxBodyBytes) {
  const method = String(check.method || defaults.method || 'GET').toUpperCase();
  const headers = { ...(defaults.headers || {}), ...(check.headers || {}) };
  const init = {
    method,
    headers,
    redirect: check.follow_redirects === false ? 'manual' : 'follow',
    signal: AbortSignal.timeout(timeout),
  };
  if (check.body !== undefined && check.body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof check.body === 'string' ? check.body : JSON.stringify(check.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const t0 = performance.now();
  let ttfb = null;
  return fetch(check.url, init)
    .then(async (res) => {
      ttfb = performance.now() - t0;
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        ok: true,
        status: res.status,
        status_text: res.statusText,
        ttfb_ms: r1(ttfb),
        total_ms: r1(performance.now() - t0),
        body_bytes: buf.length,
        content_type: res.headers.get('content-type') || '',
        redirected: res.redirected,
        final_url: res.url,
        headers: Object.fromEntries(res.headers),
        text: buf.subarray(0, maxBodyBytes).toString('utf8'),
        text_truncated: buf.length > maxBodyBytes,
      };
    })
    .catch((err) => ({
      ok: false,
      status: 0,
      error: explainNet(err, timeout),
      ttfb_ms: r1(ttfb),
      total_ms: r1(performance.now() - t0),
      body_bytes: 0,
      text: '',
    }));
}

function probeCert(host, port, timeout = 4000) {
  return new Promise((res) => {
    let sock;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock && sock.destroy(); } catch {}
      res(v);
    };
    try {
      sock = tls.connect({ host, port, servername: host, timeout, rejectUnauthorized: false }, () => {
        const cert = sock.getPeerCertificate();
        if (!cert || !cert.valid_to) return finish({ error: 'no certificate presented' });
        const notAfter = Date.parse(cert.valid_to);
        finish({
          valid_to: cert.valid_to,
          days_left: Number.isNaN(notAfter) ? null : Math.floor((notAfter - Date.now()) / 86400000),
          issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || '',
        });
      });
    } catch (e) {
      return finish({ error: e.message });
    }
    sock.on('error', (e) => finish({ error: e.code || e.name || 'tls error' }));
    sock.on('timeout', () => finish({ error: 'tls handshake timeout' }));
  });
}

function getPath(value, path) {
  const tokens = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter((t) => t !== '');
  let cur = value;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return { found: false };
    cur = Array.isArray(cur) ? cur[Number(t)] : cur[t];
    if (cur === undefined) return { found: false };
  }
  return { found: true, value: cur };
}

function matchValue(actual, found, expect, missing = 'path missing') {
  if (expect === 'exists') return found ? null : missing;
  if (expect === 'absent') return found ? `expected absent, got ${short(actual, 40)}` : null;
  if (typeof expect === 'string' && expect.startsWith('type:')) {
    const want = expect.slice(5);
    const got = !found ? 'missing' : Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;
    return got === want ? null : `expected type ${want}, got ${got}`;
  }
  if (typeof expect === 'string' && expect.startsWith('re:')) {
    let re;
    try { re = new RegExp(expect.slice(3)); } catch (e) { return `invalid regex in expect: ${expect}`; }
    if (!found) return `expected match ${expect}, ${missing}`;
    return re.test(String(actual)) ? null : `expected match ${expect}, got ${short(actual, 40)}`;
  }
  if (!found) return `expected ${short(expect, 40)}, ${missing}`;
  return String(actual) === String(expect) ? null : `expected ${short(expect, 40)}, got ${short(actual, 40)}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[body] === undefined ? m : ENTITIES[body];
  });
}

function parseTagInner(inner) {
  const m = /^([^\s/>]+)/.exec(inner);
  if (!m) throw new Error('empty tag name');
  const name = m[1];
  const attrs = {};
  const rest = inner.slice(name.length);
  const re = /([^\s/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let mm;
  while ((mm = re.exec(rest))) attrs[mm[1]] = decodeEntities(mm[2] !== undefined ? mm[2] : mm[3] || '');
  return { name, attrs };
}

// Minimal pull parser: enough for monitoring (elements, attributes, text,
// namespaces kept as literal prefixes), not a conforming XML processor — no DTD
// validation, no external entities, no namespace resolution.
function parseXml(text) {
  const src = text.replace(/^\uFEFF/, '');
  let i = 0;

  const jump = (open, close, what) => {
    const e = src.indexOf(close, i + open.length);
    if (e < 0) throw new Error('unterminated ' + what);
    i = e + close.length;
  };

  function skipMisc() {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('<!--', i)) jump('<!--', '-->', 'comment');
      else if (src.startsWith('<?', i)) jump('<?', '?>', 'processing instruction');
      else if (src.startsWith('<!', i) && !src.startsWith('<![CDATA[', i)) jump('<!', '>', 'declaration');
      else return;
    }
  }

  function parseElement(depth) {
    if (depth > MAX_DEPTH) throw new Error('nesting deeper than ' + MAX_DEPTH + ' levels');
    if (src[i] !== '<') throw new Error('expected element at offset ' + i);
    const tagEnd = src.indexOf('>', i);
    if (tagEnd < 0) throw new Error('unterminated start tag');
    const selfClosing = src[tagEnd - 1] === '/';
    const { name, attrs } = parseTagInner(src.slice(i + 1, tagEnd - (selfClosing ? 1 : 0)).trim());
    i = tagEnd + 1;
    const node = { name, attrs, children: [], text: '' };
    if (selfClosing) return node;
    let prev = -1;
    for (;;) {
      if (i === prev) throw new Error('no progress at offset ' + i);
      prev = i;
      if (i >= src.length) throw new Error('unclosed <' + name + '>');
      if (src.startsWith('</', i)) {
        const e = src.indexOf('>', i);
        if (e < 0) throw new Error('unterminated end tag');
        const closeName = src.slice(i + 2, e).trim();
        if (closeName !== name) throw new Error('mismatched </' + closeName + '> closing <' + name + '>');
        i = e + 1;
        return node;
      }
      if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i);
        if (e < 0) throw new Error('unterminated CDATA');
        node.text += src.slice(i + 9, e);
        i = e + 3;
        continue;
      }
      if (src.startsWith('<!--', i)) { jump('<!--', '-->', 'comment'); continue; }
      if (src.startsWith('<?', i)) { jump('<?', '?>', 'processing instruction'); continue; }
      if (src.startsWith('<!', i)) { jump('<!', '>', 'declaration'); continue; }
      if (src[i] === '<') { node.children.push(parseElement(depth + 1)); continue; }
      const next = src.indexOf('<', i);
      if (next < 0) throw new Error('unclosed text inside <' + name + '>');
      node.text += decodeEntities(src.slice(i, next));
      i = next;
    }
  }

  skipMisc();
  const root = parseElement(0);
  return { [root.name]: toPlain(root) };
}

// Collapse a leaf element with no attributes to its text, so paths read like the
// document: Error.Code -> "NoSuchKey". Anything richer becomes an object with
// "@attr" keys, child keys, and "#text" when it also carries text.
function toPlain(node) {
  const text = node.text.replace(/\s+/g, ' ').trim();
  const attrKeys = Object.keys(node.attrs);
  if (!node.children.length && !attrKeys.length) return text;
  const obj = {};
  for (const k of attrKeys) obj['@' + k] = node.attrs[k];
  if (text) obj['#text'] = text;
  for (const child of node.children) {
    const v = toPlain(child);
    if (obj[child.name] === undefined) obj[child.name] = v;
    else if (Array.isArray(obj[child.name])) obj[child.name].push(v);
    else obj[child.name] = [obj[child.name], v];
  }
  return obj;
}

function checkStatus(status, expect) {
  if (expect === undefined || expect === null) return null;
  if (typeof expect === 'string') {
    const m = /^([1-5])xx$/i.exec(expect.trim());
    if (m) return String(status)[0] === m[1] ? null : `expected status ${expect}, got ${status}`;
  }
  const list = Array.isArray(expect) ? expect : [expect];
  return list.includes(status) ? null : `expected status ${list.join('/')}, got ${status}`;
}

function assertPaths(label, doc, spec, fails) {
  const missing = label === 'xml' ? 'element missing' : 'path missing';
  for (const [path, want] of Object.entries(spec)) {
    const { found, value } = getPath(doc, path);
    const msg = matchValue(value, found, want, missing);
    if (msg) fails.push(`${label} ${path}: ${msg}`);
  }
}

function evaluate(expect, attempts, cert, check) {
  const fails = [];
  const last = attempts[attempts.length - 1];
  const withBody = [...attempts].reverse().find((a) => a.ok);

  if (!expect) expect = {};

  if (expect.status !== undefined) {
    attempts.forEach((a, i) => {
      const msg = checkStatus(a.status, expect.status);
      if (msg) fails.push(`status${attempts.length > 1 ? `[sample ${i + 1}]` : ''}: ${msg}`);
    });
  }

  if (expect.max_ms !== undefined) {
    const totals = attempts.map((a) => a.total_ms).filter((v) => typeof v === 'number');
    const worst = totals.length ? Math.max(...totals) : null;
    if (worst === null) fails.push(`max_ms: no completed request (all ${attempts.length} attempt(s) errored)`);
    else if (worst > expect.max_ms) fails.push(`max_ms: slowest sample ${worst}ms > ${expect.max_ms}ms (p50 ${pct(totals, 50)}ms)`);
  }

  if (expect.max_bytes !== undefined && withBody && withBody.body_bytes > expect.max_bytes) {
    fails.push(`max_bytes: ${withBody.body_bytes}B > ${expect.max_bytes}B`);
  }

  if (expect.content_type && withBody) {
    const want = String(expect.content_type).toLowerCase();
    if (!withBody.content_type.toLowerCase().includes(want)) fails.push(`content_type: expected to contain "${want}", got "${withBody.content_type || 'none'}"`);
  }

  if (expect.header) {
    for (const [name, want] of Object.entries(expect.header)) {
      const actual = withBody ? withBody.headers[name.toLowerCase()] : undefined;
      const msg = matchValue(actual, actual !== undefined, want, 'absent from response');
      if (msg) fails.push(`header ${name}: ${msg}`);
    }
  }

  if (expect.body_contains !== undefined) {
    if (!withBody) fails.push('body_contains: no response body (request failed)');
    else if (!withBody.text.includes(String(expect.body_contains))) fails.push(`body_contains: "${short(expect.body_contains, 40)}" not found in body`);
  }

  if (expect.json) {
    if (!withBody) fails.push('json: no response body (request failed)');
    else {
      let parsed;
      let error = null;
      try {
        parsed = JSON.parse(withBody.text);
      } catch (e) {
        parsed = undefined;
        error = e.message.split('\n')[0];
      }
      if (parsed === undefined) fails.push(`json: response is not valid JSON${withBody.text_truncated ? ' (body truncated at max_body_kb — raise it)' : ''}: ${error}`);
      else assertPaths('json', parsed, expect.json, fails);
    }
  }

  if (expect.xml) {
    if (!withBody) fails.push('xml: no response body (request failed)');
    else {
      let doc;
      try {
        doc = parseXml(withBody.text);
      } catch (e) {
        doc = undefined;
        fails.push(`xml: response is not well-formed XML${withBody.text_truncated ? ' (body truncated at max_body_kb — raise it)' : ''}: ${String(e.message).split('\n')[0]}`);
      }
      if (doc !== undefined) assertPaths('xml', doc, expect.xml, fails);
    }
  }

  if (expect.cert_days_left !== undefined) {
    if (!cert) fails.push('cert_days_left: not an https endpoint');
    else if (cert.error) fails.push(`cert_days_left: cannot read certificate (${cert.error})`);
    else if (cert.days_left === null) fails.push('cert_days_left: unparsable certificate expiry');
    else if (cert.days_left < expect.cert_days_left) fails.push(`cert_days_left: ${cert.days_left}d left < required ${expect.cert_days_left}d (expires ${cert.valid_to})`);
  }

  attempts.forEach((a, i) => {
    if (!a.ok) fails.push(`request${attempts.length > 1 ? `[sample ${i + 1}]` : ''}: ${a.error}`);
  });

  // When nothing got a response, per-field assertions are noise: the transport error is the real cause.
  if (!attempts.some((a) => a.ok)) return fails.filter((f) => f.startsWith('request') || f.startsWith('cert_days_left'));

  return fails;
}

async function runCheck(check, defaults, opts, cert) {
  const timeout = Number(check.timeout_ms || defaults.timeout_ms || opts.timeout);
  const maxBodyBytes = Number(check.max_body_kb || defaults.max_body_kb || 256) * 1024;
  const attempts = [];
  for (let i = 0; i < opts.samples; i++) {
    attempts.push(await oneAttempt(check, defaults, timeout, maxBodyBytes));
  }
  const totals = attempts.map((a) => a.total_ms);
  const ttfs = attempts.map((a) => a.ttfb_ms);
  const failures = evaluate(check.expect, attempts, cert, check);
  const succeeded = attempts.filter((a) => a.ok);
  return {
    name: check.name,
    url: check.url,
    method: String(check.method || defaults.method || 'GET').toUpperCase(),
    important: check.important === true,
    samples: opts.samples,
    ok: failures.length === 0,
    failures,
    status: attempts.length === 1 ? attempts[0].status : succeeded.length ? succeeded[succeeded.length - 1].status : 0,
    error: attempts.length === 1 && !attempts[0].ok ? attempts[0].error : undefined,
    ttfb_ms: pct(ttfs, 50),
    p50_ms: pct(totals, 50),
    p95_ms: pct(totals, 95),
    max_ms: totals.filter((v) => typeof v === 'number').length ? Math.max(...totals.filter((v) => typeof v === 'number')) : null,
    body_bytes: succeeded.length ? succeeded[succeeded.length - 1].body_bytes : 0,
    content_type: succeeded.length ? succeeded[succeeded.length - 1].content_type : '',
    cert_days_left: cert ? cert.days_left : null,
    cert_error: cert && cert.error ? cert.error : undefined,
    attempts: succeeded.length + '/' + opts.samples,
  };
}

// CJK and other wide characters occupy two terminal columns but count as one
// JS string unit, so column padding must measure display width, not .length.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const dw = (s) => [...String(s)].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

function pad(s, n) {
  s = String(s);
  const w = dw(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}
function lpad(s, n) {
  s = String(s);
  const w = dw(s);
  return w >= n ? s : ' '.repeat(n - w) + s;
}
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

function printTable(results, meta) {
  const nameW = Math.min(34, Math.max(10, ...results.map((r) => dw(r.name))));
  const trunc = (n) => (dw(n) > nameW ? truncToWidth(n, nameW) : n);
  const ms = (v) => (typeof v === 'number' ? v.toFixed(1) + 'ms' : '-');
  const row = (result, name, status, ttfb, p50, p95, size, cert) =>
    `  ${pad(result, 4)}  ${pad(name, nameW)}  ${lpad(status, 6)}  ${lpad(ttfb, 9)}  ${lpad(p50, 9)}  ${lpad(p95, 9)}  ${lpad(size, 8)}  ${lpad(cert, 5)}`;

  const lines = [];
  lines.push(`api-monitor · ${meta.total} check(s) · ${meta.samples} sample(s) · concurrency ${meta.concurrency} · ${meta.duration_ms}ms`);
  lines.push(`config ${meta.config}`);
  lines.push('');
  lines.push(row('OK', 'NAME', 'STATUS', 'TTFB', 'P50', 'P95', 'SIZE', 'CERT'));
  let detailLines = 0;
  for (const r of results.slice(0, MAX_ROWS)) {
    lines.push(
      row(
        r.ok ? 'yes' : 'FAIL',
        trunc(r.name),
        r.status || '-',
        ms(r.ttfb_ms),
        ms(r.p50_ms),
        ms(r.p95_ms),
        r.body_bytes + 'B',
        r.cert_days_left === null || r.cert_days_left === undefined ? '-' : r.cert_days_left + 'd'
      )
    );
    if (!r.ok) {
      for (const f of r.failures.slice(0, MAX_DETAIL_PER_CHECK)) {
        if (detailLines++ >= MAX_DETAIL_LINES) break;
        lines.push(`        └ ${short(f, 150)}`);
      }
      if (r.failures.length > MAX_DETAIL_PER_CHECK) lines.push(`        └ … ${r.failures.length - MAX_DETAIL_PER_CHECK} more (use --json)`);
    }
  }
  if (results.length > MAX_ROWS) lines.push(`  … ${results.length - MAX_ROWS} more check(s) not shown (use --json or --filter)`);
  lines.push('');
  const failed = results.filter((r) => !r.ok);
  const p95s = results.map((r) => r.p95_ms).filter((v) => typeof v === 'number');
  lines.push(`  ${results.length - failed.length}/${results.length} passed${p95s.length ? ` · fleet p95 ${pct(p95s, 95)}ms` : ''}${meta.history ? ` · history ${meta.history}` : ''}`);
  if (failed.length) lines.push(`  failed: ${failed.map((r) => r.name).join(', ')}`);
  console.log(lines.join('\n'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const cfg = opts.urls.length ? adHocConfig(opts) : loadConfig(opts.config);
  const startedAt = Date.now();
  const t0 = performance.now();

  let checks = cfg.checks;
  if (opts.filter) {
    checks = checks.filter((c) => c.name.toLowerCase().includes(opts.filter.toLowerCase()));
    if (!checks.length) fail(`--filter "${opts.filter}" matched no check names. Available: ${cfg.checks.map((c) => c.name).join(', ')}`);
  }

  const hosts = new Map();
  for (const c of checks) {
    const u = new URL(c.url);
    if (u.protocol === 'https:') hosts.set(u.hostname + ':' + (u.port || 443), { host: u.hostname, port: Number(u.port || 443) });
  }
  const hostList = [...hosts.entries()];
  const certs = new Map();
  if (hostList.length) {
    const certResults = await pool(hostList, 8, ([key, h]) => probeCert(h.host, h.port));
    hostList.forEach(([key], i) => certs.set(key, certResults[i]));
  }
  const certFor = (url) => {
    const u = new URL(url);
    return u.protocol === 'https:' ? certs.get(u.hostname + ':' + (u.port || 443)) : null;
  };

  const results = await pool(checks, opts.concurrency, (c) => runCheck(c, cfg.defaults, opts, certFor(c.url)));
  const duration_ms = Math.round(performance.now() - t0);

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    critical_failed: results.filter((r) => !r.ok && r.important).length,
    duration_ms,
  };

  let historyPath = null;
  if (opts.history !== 'off') {
    historyPath = resolve(opts.history || '.api-monitor/history.jsonl');
    const record = {
      ts: new Date(startedAt).toISOString(),
      config: basename(cfg.path),
      samples: opts.samples,
      summary,
      checks: results.map((r) => ({
        name: r.name,
        url: r.url,
        ok: r.ok,
        important: r.important,
        status: r.status,
        ttfb_ms: r.ttfb_ms,
        p50_ms: r.p50_ms,
        p95_ms: r.p95_ms,
        body_bytes: r.body_bytes,
        cert_days_left: r.cert_days_left,
        failures: r.failures.slice(0, 5),
      })),
    };
    try {
      mkdirSync(dirname(historyPath), { recursive: true });
      appendFileSync(historyPath, JSON.stringify(record) + '\n');
    } catch (e) {
      console.error(`warning: could not write history to ${historyPath} — ${e.message.split('\n')[0]}`);
      historyPath = null;
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ started_at: new Date(startedAt).toISOString(), config: cfg.path, summary, results, history: historyPath }, null, 2));
  } else {
    printTable(results, { ...summary, samples: opts.samples, concurrency: opts.concurrency, config: cfg.path, history: historyPath });
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => fail(`probe.mjs crashed: ${(e && e.message) || e}`));
