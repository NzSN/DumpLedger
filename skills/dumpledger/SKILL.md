---
name: dumpledger
description: Search a DumpLedger instance for Windows minidumps, download and triage them, resolve application PDBs through DumpLedger's symsrv-compatible symbol store (CDB/WinDbg), and record analysis reports back. Use for any dump hunting, crash triage, symbolication, or DumpLedger API task.
whenToUse: A user mentions DumpLedger, a dump ID / customer / case, a Windows crash dump to investigate, missing symbols, or asks to search for / analyze minidumps.
---

# DumpLedger dump search and symbol analysis

DumpLedger is a self-hosted intake ledger for Windows minidumps. It owns the
customer/case/dump catalog, the dump vault, and a PDB/EXE symbol store. It does
not run analyses itself: you search the ledger, retrieve bytes, run your own
debugger (or PDB tooling), then optionally record the verdict as an analysis
report.

Prefer the **analyzer bearer token** over browser/operator sessions. It is
read-mostly, has no CSRF or cookie handling, and is the intended machine path.
A full task-oriented backgrounder exists in
[`docs/analyzer-guide.md`](../../docs/analyzer-guide.md); the wire reference is
[`docs/http-api.md`](../../docs/http-api.md).

## 1. Connect and verify

Get these from the user's environment or secret store — never invent them:

| Variable | Meaning | Default for local dev |
| --- | --- | --- |
| `DUMP_LEDGER_BASE_URL` | API origin, e.g. `https://ledger.example:4080` | `http://127.0.0.1:4080` |
| `DUMP_LEDGER_ANALYZER_TOKEN` | Analyzer bearer secret | none — ask the operator |
| `DUMP_LEDGER_SYMBOLS_URL` | Optional symsrv base URL; set when the instance uses the dedicated listener (`http://127.0.0.1:4082/symbols`) | `$DUMP_LEDGER_BASE_URL/symbols` |
| `DUMP_LEDGER_CA_CERT` | Optional PEM CA bundle for a self-signed deployment | none |

Bootstrap per shell (do not echo the token, do not put it in URLs, scripts,
logs, or commits). `BASE` is the origin only — no trailing slash and no
`/api/v1` suffix; if the token comes from a file, strip the trailing newline:

```bash
BASE="${DUMP_LEDGER_BASE_URL:-http://127.0.0.1:4080}"
TOKEN="${DUMP_LEDGER_ANALYZER_TOKEN:?export DUMP_LEDGER_ANALYZER_TOKEN first}"
# TOKEN=$(tr -d '\r\n' < /path/to/token-file)
AUTH="Authorization: Bearer $TOKEN"
SYM="${DUMP_LEDGER_SYMBOLS_URL:-$BASE/symbols}"

dl() { curl -fsS -H "$AUTH" "$BASE$1"; }          # read helper
dla() { curl -sS -H "$AUTH" "$BASE$1"; }          # read helper, keeps error bodies
```

Never use `curl -v` or `set -x` around authenticated calls: both print the
`Authorization` header.

Verify reachability and auth with one read (`200` = good; `401` = the server
has no analyzer token configured, or the token is wrong — ask the operator):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -H "$AUTH" "$BASE/api/v1/dumps?phase=available"
dl "/api/v1/dumps?phase=available" | python3 -m json.tool | head -40
```

For a self-signed deployment, pass `--cacert "$DUMP_LEDGER_CA_CERT"` (install
the issuing CA instead of disabling verification), or export
`CURL_CA_BUNDLE="$DUMP_LEDGER_CA_CERT"` so the `dl`/`dla` helpers and every
other curl call trust it. `curl -k` is acceptable only for an explicitly local
throwaway instance.

### Analyzer token scope

The token is accepted on these routes:

- `GET /api/v1/dumps` — catalog search
- `GET /api/v1/dumps/by-sha256/:sha256` — exact content lookup
- `GET /api/v1/dumps/:dumpId` — dump detail
- `GET /api/v1/dumps/:dumpId/content` — dump bytes
- `GET /api/v1/dumps/:dumpId/analyses` — recorded reports
- `POST /api/v1/dumps/:dumpId/analyses` — compact analysis write-back
- `GET /api/v1/events` — audit event feed
- `GET /api/v1/customers` — customer id/display-name resolution
- `GET /api/v2/capabilities`, `POST /api/v2/dumps/:dumpId/analyses`,
  `GET /api/v2/dumps/:dumpId/analyses/:analysisId` — rich reports v2
  (512 KiB canonical report, 1 MiB request; see
  [`docs/rich-reports.md`](../../docs/rich-reports.md))

It rejects everything else, including case search, symbol list/ingest, retention
changes, and transfers. On these analyzer routes, any `Authorization` header
selects the bearer path only: a wrong or missing digest is a generic `401`,
never a cookie fallback. Routes outside this list ignore `Authorization`
entirely, so a session cookie still authenticates there.
The response envelope for errors is `{"error":{"code","message","retryable"}}`.

If the human supplies an operator password instead of a token, log in per
[`docs/http-api.md` §Sessions](../../docs/http-api.md#sessions) (cookie plus a
`csrfToken` for mutations) and never store the password. Prefer the analyzer
token for everything this skill does.

## 2. Find dumps (catalog search)

`GET /api/v1/dumps` is the dump catalog search. All query parameters are
optional and may appear at most once; unknown parameters are rejected.

| Parameter | Match |
| --- | --- |
| `caseId` | exact case id |
| `customerId` | exact customer id |
| `phase` | `receiving` \| `sealed` \| `quarantined` \| `available` \| `rejected` \| `deleting` \| `deleted` |
| `validation` | `not-checked` \| `valid` \| `invalid` \| `transfer-failed` |
| `receivedAfter`, `receivedBefore` | inclusive bounds, canonical UTC ISO (`2026-01-31T00:00:00.000Z`) |
| `architecture` | exact inspector string: `x86`, `arm`, `ia64`, `x86_64`, `arm64` |
| `exceptionCode` | canonical **decimal** unsigned 32-bit value (`printf '%d' 0xC0000005` → `3221225477`) |
| `sha256` | exact lowercase 64-hex content hash |
| `cursor` | opaque keyset cursor returned as `nextCursor` |

Rows are ordered by `(receivedAt, dumpId)` **ascending**, at most 200 per page.
Repeat the request with the same filters plus `nextCursor`; an absent
`nextCursor` ends the scan. Pagination does not pin a snapshot. IDs are opaque
server-issued strings — substitute them verbatim and URL-encode path segments.

There is **no free-text / filename search**. Narrow with filters (customer,
time window, exception, phase), then match `originalName` locally. If you also
hold an operator session, `GET /api/v1/cases?query=<text>` searches case ID,
title, customer ID, and customer display name; feed the matched `caseId` into
the catalog filter. The analyzer token cannot call that route.

Resolve a customer display name first:

```bash
dla "/api/v1/customers" | python3 -c '
import json, sys
for c in json.load(sys.stdin)["customers"]:
    print(c["customerNo"], c["customerId"], c["displayName"], sep="\t")'
```

Useful searches:

```bash
# Fill these in from previous steps: CUSTOMER_ID, SHA256, dumpId
# Available dumps for one customer, one page.
# Ordering is oldest -> newest (receivedAt ascending); page to the end for newest.
dla "/api/v1/dumps?customerId=$CUSTOMER_ID&phase=available" | python3 -c '
import json, sys
for d in json.load(sys.stdin)["dumps"]:
    print(d["receivedAt"], d["dumpId"], d.get("architecture", "-"), d.get("exceptionCode", "-"),
          d["symbolCoverage"]["present"], d["symbolCoverage"]["missing"],
          d["originalName"], sep="\t")'

# Access violations received in the last 7 days (then page with nextCursor)
after=$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')
dla "/api/v1/dumps?phase=available&exceptionCode=3221225477&receivedAfter=$after" | python3 -m json.tool

# Duplicate check before treating a dump as new (64 lowercase hex sha256)
dla "/api/v1/dumps/by-sha256/$SHA256" | python3 -m json.tool

# Find a dump by original filename across one page
dla "/api/v1/dumps?customerId=$CUSTOMER_ID" | python3 -c '
import json, re, sys
pattern = re.compile(sys.argv[1], re.I)
for d in json.load(sys.stdin)["dumps"]:
    if pattern.search(d["originalName"]):
        print(d["dumpId"], d["phase"], d["originalName"], sep="\t")' "crash"

# Page all available dumps (Ctrl-C to stop)
cursor=""
while :; do
  url="/api/v1/dumps?phase=available"
  if [ -n "$cursor" ]; then url="$url&cursor=$cursor"; fi
  page=$(dl "$url")
  printf '%s' "$page" | python3 -c '
import json, sys
for d in json.load(sys.stdin)["dumps"]:
    print(d["receivedAt"], d["dumpId"], d["originalName"], sep="\t")'
  cursor=$(printf '%s' "$page" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("nextCursor",""))')
  if [ -z "$cursor" ]; then break; fi
done
```

Fields on each catalog row: `dumpId`, `caseId`, `customerId`, `phase`,
`validation`, `originalName`, `byteSize` (decimal string, null until sealed),
`sha256` (null until sealed), timestamps, `architecture`, `exceptionCode`
(number), `exceptionAddress` (decimal string) — the last three only when
inspection succeeded — and aggregate `symbolCoverage` counts
(`present`/`missing`/`unidentified`).

## 3. Inspect and fetch one dump

```bash
dumpId="dump_..."
dl "/api/v1/dumps/$dumpId" | python3 -m json.tool
```

Detail adds `case.title`, `downloadable`, `purgeAt`/`purgedAt`,
`inspectionError`, `coverage`, a per-module `symbolCoverage` array, and the
last 200 audit activities. `coverage` is `partial`,
`full-memory-declared` (a minidump *declaration*, not proof all memory was
captured), `unknown`, or `null` before classification.

Check prior verdicts before spending effort — they also prevent duplicate
reports:

```bash
dl "/api/v1/dumps/$dumpId/analyses" | python3 -m json.tool
```

Download and integrity-check the bytes (only `available` + `downloadable`
dumps serve content; `ETag` equals the quoted sha256):

```bash
CACHE="${DUMP_LEDGER_CACHE_DIR:-.dumpledger-cache}"
mkdir -p "$CACHE" && chmod 700 "$CACHE"

detail=$(dl "/api/v1/dumps/$dumpId")
sha=$(printf '%s' "$detail" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"] or "")')
out="$CACHE/${sha:-$dumpId}.dmp"

if [ -z "$sha" ]; then
  echo "dump has no sealed sha256 yet (not available/downloadable)" >&2
  exit 1
fi
if [ ! -s "$out" ]; then
  curl -fsS -H "$AUTH" -o "$out.part" "$BASE/api/v1/dumps/$dumpId/content" \
    && printf '%s  %s\n' "$sha" "$out.part" | sha256sum -c - \
    && mv "$out.part" "$out" \
    || rm -f "$out.part"
  test -s "$out" || { echo "download or integrity check failed" >&2; exit 1; }
fi

# Refetch revalidation: a current cached copy returns 304
curl -sS -o /dev/null -w '%{http_code}\n' -H "$AUTH" \
  -H "If-None-Match: \"$sha\"" "$BASE/api/v1/dumps/$dumpId/content"
```

Treat dump bytes as confidential: cache under a gitignored, permission-
restricted directory, never commit or paste them, and delete them when the
analysis is finished (`.dumpledger-cache/` is a good default; add it to
`.gitignore` if you create it in a repository). `sha256sum -c` is Linux; on
macOS use `shasum -a 256 -c` instead.

**No debugger available?** Triaging from ledger facts is legitimate: the
catalog row gives `exceptionCode` and `architecture` (detail does not; fetch the
catalog entry, e.g. via `by-sha256`), while detail gives `coverage` and
`symbolCoverage`; prior `analyses` may already answer the question. Do not
claim stack-level conclusions without a real stack.

## 4. Symbols — preflight and configure the store

Dump detail exposes one `symbolCoverage` row per inspected module. `status` is
one of:

| `status` | Meaning |
| --- | --- |
| `present` | matching artifact is in DumpLedger (`artifactId` set) |
| `missing` | debug identity known, but no artifact in the store |
| `unidentified` | no usable debug identity was recovered from the dump (e.g. old dump) |

Each row also carries a separate `system` boolean — a display hint for OS-owned
modules (`Windows\System32`, `SysWOW64`, `WinSxS`), independent of `status`. A
system module can be `present` if its PDB was ingested, but treat OS symbols as
coming from Microsoft's public server by default.

List the application modules that will not resolve:

```bash
dl "/api/v1/dumps/$dumpId" | python3 -c '
import json, sys
for m in json.load(sys.stdin)["symbolCoverage"]:
    if not m["system"] and m["status"] != "present":
        print(m["status"], m["name"], m["debugFile"], m["debugId"], sep="\t")'
```

If app modules are `missing`, ask the operator to ingest the matching build's
PDB (server-side `POST /api/v1/symbols`, operator session or CI ingest token —
the analyzer token cannot ingest), or state clearly in the report which frames
stayed unresolved. `unidentified` modules cannot be resolved from this dump at
all. `system` modules need Microsoft symbols — see below. The analyzer token
also cannot list the symbol store; use `symbolCoverage` as the preflight.

### Store URL grammar

The debugger store is public and outside `/api/v1`:

```text
GET /symbols/<name>/<id>/<file>
```

- PDB: `name` = debug file name (`debugFile`), `id` = GUID+age (`debugId`),
  `file` = the same debug file name.
- EXE/DLL: `name` = image file name (`codeFile`), `id` = timestamp+image size
  (`codeId`), `file` = the same image name. Dump detail's `symbolCoverage`
  rows expose PDB debug identities only; the image `codeFile`/`codeId` pair is
  available from the session-only `GET /api/v1/symbols` list, and debuggers
  request image symbols by that code identity themselves.
- IDs are case-insensitive; a miss is a plain `404`; bytes are immutable and
  cache for a year. URL-encode the name segments if they contain spaces.

Preflight one module directly (200 = present, 404 = not in store):

```bash
name="$debugFile"
enc=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$name")
curl -sS -o /dev/null -w '%{http_code}\n' "$SYM/$enc/$debugId/$enc"
```

If you have tooling that consumes a PDB file instead of symsrv, fetch the
artifact and inspect it locally:

```bash
curl -fsS "$SYM/$enc/$debugId/$enc" -o "$debugFile"   # verify GUID/age with your PDB tool
```

### Configure CDB / WinDbg (`symsrv`)

Use the dedicated loopback listener when the operator started one, otherwise
the main API origin. The listener is off unless `DUMP_LEDGER_SYMBOLS_PORT` is
set; `DUMP_LEDGER_SYMBOLS_HOST` selects the bind (default loopback), and any
non-loopback bind requires `DUMP_LEDGER_SYMBOLS_TLS_CERT` plus
`DUMP_LEDGER_SYMBOLS_TLS_KEY`.

```text
# loopback dedicated listener (HTTP)
.sympath SRV*C:\symcache*http://127.0.0.1:4082/symbols
# shared API origin (HTTPS in a real deployment; use the actual origin)
.sympath SRV*C:\symcache*https://<host>:4080/symbols
```

Hard rules, verified against symsrv.dll:

- Exactly **one HTTP store** allowed, and it must be **last** in the path. A
  second HTTP store makes the debugger reject the whole path with
  `Any HTTP store must be the last store in the list`.
- Local directory stores may come before it, e.g.
  `.sympath C:\localsymbols;SRV*C:\symcache*http://127.0.0.1:4082/symbols`.
- Microsoft's public symbol server cannot be chained behind DumpLedger. When
  OS frames matter, either pre-populate a local directory store or swap the
  path: `.sympath SRV*C:\symcache*https://msdl.microsoft.com/download/symbols`.
  Symbol lookups exchange only module identities — never dump bytes — but
  follow the operator's network policy.
- A TLS certificate for a remote symbol listener must be trusted by the
  analysis machine's CA store. Disabling certificate validation is not a fix.
- Debugger users do not need DumpLedger credentials; the symbol route is
  unauthenticated and read-only by design.

## 5. Analyze with CDB / WinDbg

Run the debugger on a machine that can reach the symbol store (typically
Windows, or a Windows host over SSH); copy the cached dump there first. Set the
symbol path on the command line, open the dump, and run the sequence
automatically:

```bat
cdb -z "C:\dumpcache\<sha>.dmp" -y "srv*C:\symcache*http://127.0.0.1:4082/symbols" -c "!sym noisy; .reload; !analyze -v; .ecxr; kv; lm; q"
```

`-z` opens the dump, `-y` sets the symbol path, and `-c` runs the
semicolon-separated commands; the trailing `q` quits. Quoting differs on
cmd/PowerShell/Git Bash. Interactive equivalent:

```text
.sympath SRV*C:\symcache*http://127.0.0.1:4082/symbols
!sym noisy
.reload
.reload /f
!analyze -v
.ecxr
kv
lm
q
```

Read, in order:

1. `!analyze -v` — exception code, faulting module/address, likely stack.
2. `kv` after `.ecxr` — parameterized call stack for the faulting context.
3. `lm` — module list; a resolved module shows `(private pdb symbols)`.
4. Targeted checks: `lmv m <module>`, `x <module>!*<symbol>*`,
   `.reload /f <module>` (force symbol load for one module).

Symbol troubleshooting: if frames are `module+offset` or `lm` says
`(deferred)`, run `.reload /f`; if a module shows `(export symbols)` /
`(no symbols)`, confirm its `symbolCoverage` row is `present` and rerun with
`!sym noisy` to see the store request/error. For OS modules use Microsoft
symbols via a separate path (above) — DumpLedger deliberately does not proxy
them. To verify a store independently, use `symchk` against the matching
binary: `symchk /v <file.dll> /s SRV*C:\symcache*http://127.0.0.1:4082/symbols`.

Correlate the debugger result with catalog facts (`exceptionCode`,
`architecture`, module names) and with the dump's `coverage`: a `partial`
minidump can lack the memory `!analyze` wants, so say what was actually
available instead of overclaiming.

## 6. Record the analysis (write-back)

The analyzer token's write-back mutation is recording one report (v1 compact;
v2 rich reports below). It is idempotent on
`(dumpId, analyzer.name, analyzer.version, kind, inputSha256)`:
fresh → `201`, replay → `200` with the stored report, and `inputSha256` must
equal the dump's sealed sha256. **Check existing reports first**, then write
only durable findings: exception, faulting module/function, unresolved symbol
caveats, confidence, and links/IDs the reader can verify.

Constraints: `analyzer.name` ≤128, `analyzer.version` ≤64, `kind` ≤64 (a plain
string such as `triage`, `symbolication`, `classification`), `summary` ≤2000
characters, `facts` ≤4 KiB JSON, at most 64 distinct reports per dump, and
`outcome` is exactly `completed` or `failed`; the whole JSON body must also fit
the server's 16 KiB request limit. If you recognize that this crash
duplicates another dump, set `duplicateOf` to that dump's ID instead of
inventing a free-text link. `analyzer.name`/`version` are self-reported
attribution, not credentials: use a stable name and bump `version` whenever the
analysis logic changes; never reuse a version for different behavior.

```bash
body_dir="${TMPDIR:-/tmp}"
umask 077    # transient report bodies may contain analysis details
sha=$(dl "/api/v1/dumps/$dumpId" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')

python3 - "$sha" > "$body_dir/analysis.json" <<'PY'
import json, sys
print(json.dumps({
    "analyzer": {"name": "cdb-triage", "version": "1.0.0"},
    "kind": "triage",
    "inputSha256": sys.argv[1],
    "outcome": "completed",
    "summary": "Access violation 0xC0000005 reading 0x...; faulting frame app!Foo+0x2a (PDB resolved).",
    "facts": {"exceptionCode": "0xC0000005", "faultingModule": "app.dll",
              "coverage": "partial", "symbolsResolved": True},
}, indent=2))
PY

curl -sS -o "$body_dir/analysis-response.json" -w '%{http_code}\n' \
  -H "$AUTH" -H 'Content-Type: application/json' \
  --data-binary @"$body_dir/analysis.json" \
  "$BASE/api/v1/dumps/$dumpId/analyses"
```

Never put dump bytes, customer-identifying memory strings, tokens, or secrets
in `summary`/`facts`; they are untrusted, ledger-visible text. Do not write
back if the user asked only to find or inspect a dump — ask first.

For the larger canonical report (provenance, exception, context, stack,
symbols, rootCause, evidence, completeness), use the v2 endpoints: check
`GET /api/v2/capabilities`, then `POST /api/v2/dumps/:dumpId/analyses` (all
v1 fields plus `reportJson` and `reportDigest`; request ≤1 MiB, report
≤512 KiB) and read it back with
`GET /api/v2/dumps/:dumpId/analyses/:analysisId`. The v2 `facts` must also
preserve `schemaVersion: 2`, `reportId`, `reportDigest`, `exceptionCode`,
`frameCount`, and `causeStatus`, and `reportJson` must validate the canonical
schema — the compact v1 example above is **not** a valid v2 body. It is the
same analyzer token and the same idempotency idea; see
[`docs/rich-reports.md`](../../docs/rich-reports.md). For ordinary triage the
compact v1 report above is sufficient.

## 7. Follow new intake (event feed)

Instead of rescanning the catalog, poll the audit feed — `nextCursor` is always
present (a beyond-end page echoes your position), so sleep and retry. Actions
relevant to analysis: `AcceptDump` (bytes now available), `RejectDump`,
`BeginPurge`, `FinishPurge`, `IngestSymbol`, `PurgeSymbol`, `RecordAnalysis`,
`AuthorizeDownload`.

```bash
cursor=0
page=$(dl "/api/v1/events?since=$cursor&actions=AcceptDump,RejectDump&limit=200")
printf '%s' "$page" | python3 -m json.tool          # events[] + nextCursor
# next poll: since=<previous nextCursor>; 5–30 s cadence is enough
```

## 8. Rules that keep this safe

- Dumps are sensitive process memory. Keep bytes in a local, gitignored,
  `chmod 700` cache; never upload them to third-party services (public symbol
  servers receive only PDB identity lookups, not dumps); delete them when done.
- The analyzer token is a secret: environment/secret store only, never in
  URLs, shell history, logs, PRs, or chat. Avoid `curl -v` and `set -x`.
- Least privilege: the token cannot ingest symbols, change retention, run case
  transitions, or transfer bundles. Do not try; ask the operator/human.
- Verify `DUMP_LEDGER_BASE_URL` belongs to the intended instance before bulk
  downloads, and trust the deployment's CA rather than disabling TLS checks.
- Read responses are stable and safe to retry after network errors; note that
  a content download appends an `AuthorizeDownload` audit event on every
  `200`, so retries add audit rows. Analysis write-back is idempotent. On
  `429`/`503` honour `Retry-After`; only `rate_limited`, `upload_busy`,
  `storage_unavailable` are retryable.
- If `/api/v1/dumps` answers `401`, stop and ask for a working token — do not
  fall back to trying passwords or cookies.

## 9. Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| `401 unauthenticated` on every read | `DUMP_LEDGER_ANALYZER_TOKEN` unset/wrong/rotated (the operator replaces the configured sha256 and restarts); server may have `DUMP_LEDGER_ANALYZER_TOKEN_HASH` unset. On analyzer routes, any `Authorization` header selects bearer-only auth, so a bad token wins over a session cookie. |
| `400 invalid_request` | Unknown/repeated query param, non-canonical timestamp or decimal, malformed cursor, or an analysis body that violates a field bound / `inputSha256` mismatch. |
| `404 not_found` on content | Dump not `available`/`downloadable`, or purged. Re-check `phase` via the feed/catalog; dump bytes are gone for good after `FinishPurge`. |
| `404` on the symbol URL in a debugger | Module is `missing`/`unidentified`, artifact was purged, or name/id/file segments are wrong. Preflight the URL with `curl` and check `symbolCoverage`. |
| Debugger rejects `.sympath` | More than one HTTP store, or HTTP store not last. Use exactly one, last; put local directory stores before it. |
| Symbols silently don't load | `!sym noisy` then `.reload /f`; verify TLS trust for a remote listener; confirm the PDB matches the dump's build (GUID+age). |
| `!analyze -v` shows little / no stack | Missing PDBs for app modules, wrong architecture dump, or `coverage: partial` (memory not captured). Report the limitation instead of guessing. |
| `409 invalid_transition` on write-back | Dump is not `available`, or the 64-report cap is reached. A same-identity replay still returns `200`. |
| Pages look stale / repeat rows | Reuse the **same** filters on every page and pass the previous `nextCursor`; pagination is not a snapshot, so newly received dumps can appear later. |

## 10. References

- [Analyzer integration guide](../../docs/analyzer-guide.md) — end-to-end loop, webhooks.
- [HTTP API reference](../../docs/http-api.md) — every route, field, limit, error.
- [Symbols design](../../docs/symbols-design.md) — identity model, symsrv path grammar, debugger evidence.
- [Security model](../../docs/security-model.md) — analyzer token scope, symbol listener threat model.
- [README](../../README.md) — running an instance, symbol-listener env vars.
- Contracts: [`catalog.ts`](../../packages/http-contracts/src/catalog.ts),
  [`dumps.ts`](../../packages/http-contracts/src/dumps.ts),
  [`analyses.ts`](../../packages/http-contracts/src/analyses.ts),
  [`symbols.ts`](../../packages/http-contracts/src/symbols.ts).
