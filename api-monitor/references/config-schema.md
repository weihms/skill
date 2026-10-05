# Config schema

`probe.mjs` reads one JSON file. JSON is used deliberately: no YAML parser
dependency, and a malformed file fails with an exact position instead of a
silent mis-parse.

Discovery order when `--config` is omitted:

1. `./api-monitor.config.json`
2. `./.api-monitor/config.json`

Add the file to `.gitignore` if it contains internal hostnames, or keep the
config committed and inject secrets via environment variables (see below).

## Top level

```json
{
  "defaults": { "timeout_ms": 8000, "max_body_kb": 128, "headers": {} },
  "checks": [ { "name": "...", "url": "https://..." } ]
}
```

`checks` must be non-empty. Every other field is optional.

## defaults

| field | default | meaning |
| --- | --- | --- |
| `timeout_ms` | CLI `--timeout` (10000) | per-request budget, includes body |
| `max_body_kb` | 256 | bytes read before truncation; bounds `body_contains` / `json` |
| `headers` | `{}` | merged under each check's own `headers` |
| `method` | `GET` | used when a check omits `method` |

## check

| field | notes |
| --- | --- |
| `name` | required, unique. It is the history key — renaming a check resets its trend and shows up as added/removed drift |
| `url` | required, `http(s)://` |
| `method` | any verb; `body` is ignored for `GET`/`HEAD` |
| `headers` | object; overrides `defaults.headers` case-insensitively by name |
| `body` | string sent as-is, or object sent as JSON (sets `content-type: application/json` unless you set one) |
| `follow_redirects` | `false` uses `redirect: manual`, so a 301 is evaluated as a 301 |
| `timeout_ms` | overrides `defaults.timeout_ms` for this check |
| `max_body_kb` | overrides `defaults.max_body_kb` |
| `important` | `true` counts the check toward `summary.critical_failed`; use for revenue/landing paths |
| `expect` | assertions, see below. Omit to only require that the request completes |

## expect

| key | accepted values | fails when |
| --- | --- | --- |
| `status` | `200`, `[200, 204]`, `"2xx"`…`"5xx"` | status not in the set, per sample |
| `max_ms` | number | slowest sample's total time exceeds it |
| `max_bytes` | number | response body larger than it |
| `content_type` | substring | response `content-type` does not contain it (case-insensitive) |
| `header` | `{ "cache-control": "exists" \| "no-store" \| "re:^max-age" }` | header absent, or value does not match |
| `body_contains` | substring | literal not found in the decoded body |
| `json` | `{ "<path>": <expectation> }` | any path assertion fails, or the body is not valid JSON |
| `xml` | `{ "<path>": <expectation> }` | any path assertion fails, or the body is not well-formed XML |
| `cert_days_left` | number | TLS certificate expires sooner, or cannot be read |

### json paths

Dots and bracket indices: `data.items[0].id`, `meta.total`, `errors`.

### json expectation grammar

| form | matches |
| --- | --- |
| `"exists"` | path resolves to anything except `undefined` |
| `"absent"` | path does not resolve — use to pin a field that must disappear |
| `"type:array"` | also `string` `number` `boolean` `object` `null` |
| `"re:^v[0-9]"` | JavaScript regex against `String(value)`; no flags |
| any other string / number / boolean | `String(actual) === String(expected)`, so `true` matches `"true"` and `200` matches `"200"` |

A path into a non-object (e.g. `slideshow.title.deep`) reports `path missing`
rather than throwing.

### xml paths

Same expectation grammar as `json`. The document is read into plain values,
starting at the root element name:

```json
"xml": {
  "Error.Code": "NoSuchKey",
  "rss.@version": "2.0",
  "rss.channel.item": "type:array",
  "rss.channel.item[1].guid": "re:^urn:uuid:",
  "root.@total": "2",
  "env:Envelope.env:Fault.faultcode": "env:Server",
  "soap:Client": "absent"
}
```

| construct | path | note |
| --- | --- | --- |
| element text | `Error.Code` | a leaf element with no attributes collapses to its trimmed text, so it compares as a string |
| attribute | `rss.@version` | `@` prefix; a node with attributes never collapses |
| own text of a richer node | `item.#text` | `#text` key, present only when the node also has attributes or children |
| repeated siblings | `rss.channel.item` | becomes an array — assert `type:array`, then index `item[1].title` |
| empty or self-closing | `<item/>` → `""` | matches `exists`, and `absent` correctly fails |
| namespace prefixes | `env:Envelope` | kept literally; there is no namespace resolution, so a differently-prefixed alias for the same namespace will not match |
| mixed content | `item.em` | `#text` holds only the element's own text nodes, not descendants' — `<item>Why <em>X</em> great</item>` gives `#text` = `"Why great"` |

Whitespace inside text is collapsed to single spaces before comparison.

Not supported: DTD validation, external entities, `DOCTYPE` internal subsets
they reference, namespace-aware matching, processing instructions beyond
skipping them, and element order across differently-named siblings. Nesting
beyond 100 levels is rejected rather than crashing the parser.

A `<!DOCTYPE html>` document parses as XML if it is well-formed, so pair XML
checks with `content_type` when you need to catch an HTML error page served
where XML was expected.

## Which sample is asserted

`status` and `max_ms` apply to every sample. Body assertions (`json`, `xml`, `body_contains`, `header`, `content_type`,
`max_bytes`) apply to the most recent sample that produced a response.

If no sample got a response at all, only the transport error is reported —
asserting `status: expected 200, got 0` on top of `ENOTFOUND` would be noise.

## Environment variables

Any string in the config may embed `${VAR}`, resolved from the environment
before the run:

```json
{ "headers": { "authorization": "Bearer ${API_TOKEN}", "x-tenant": "${TENANT_ID}" } }
```

An unset variable is a hard config error listing the missing names, so a run
never silently sends the literal `${API_TOKEN}`. Set them in the shell that
runs the probe, or in the scheduled task's environment.

## Certificates

For every distinct `https` host, one extra TLS handshake is made (4s budget,
`rejectUnauthorized: false` so an expired or self-signed cert is still
reported rather than aborting the probe). Failures are non-fatal: `cert_days_left`
becomes `null`, `cert_error` carries the reason, and the check only fails if it
actually asserted `cert_days_left`.

## Worked example

`assets/endpoints.example.json` covers every assertion type against public
endpoints (`www.example.com`, `httpbin.org`) so it runs green out of the box.
Copy it, then replace the checks with real targets.
