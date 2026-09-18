# Symbols design

Status: milestones 1–3 implemented (2026-09-16 through 2026-09-18;
decisions D1–D4 resolved 2026-09-16, D2 superseded by milestone 3). Only
the explicitly optional Breakpad `.sym` generation remains unscheduled.
Manages minidump symbol artifacts (PDB/EXE) inside DumpLedger so dumps and
their debugging symbols live in one place: one auth surface, one audit
trail, one backup story, one deployment.

## Purpose and scope

Three capabilities over one new entity pair:

- **Ingest** — operators (later: release pipelines) register PDB/EXE files;
  the server derives symbol identity from the bytes and dedups by it.
- **Serve** — a read-only, symsrv-protocol-compatible HTTP surface so
  CDB/WinDbg resolve application symbols straight from DumpLedger
  (`.sympath SRV*C:\symcache*https://<host>/symbols*https://msdl.microsoft.com/download/symbols`).
- **Link** — minidump intake extracts module debug identities, so every dump
  shows symbol coverage and every missing build is visible on the case page.

Non-goals for v1: Breakpad `.sym` generation, `.pd_` compression, symbol
retention automation, CI ingest tokens, EXE artifacts (PDB-first), symbol
payloads inside transfer bundles.

## Vocabulary

Per CONTEXT.md discipline, new domain terms are fixed here:

**Module**:
One loadable binary image identity: `code_file`/`code_id` plus
`debug_file`/`debug_id`, annotated with product, version, and architecture.
A dump references many modules; a module may serve many dumps.
_Avoid_: library, binary, package

**Symbol artifact**:
One immutable file (kind `pdb`, later `exe`) that satisfies one module's
debug identity, bytes stored in the vault. Re-ingesting the same identity is
a no-op.
_Avoid_: debug blob, symbol dump

**Symbol store**:
The artifact collection plus the symsrv-protocol read surface.
_Avoid_: symbol server, pdb folder

## Identity model (the correctness-critical section)

Symbol resolution lives and dies by identity. The server — never the
uploader — derives it from artifact bytes:

- **Debug identity (PDB)**: parse the RSDS CodeView record → 16-byte GUID +
  4-byte age. The store path segment formats the GUID per SymSrv byte-order
  convention (first three components little-endian) followed by the age in
  hex — verified against a live debugger in tests (see test plan).
- **Code identity (EXE, deferred)**: PE header `TimeDateStamp` +
  `SizeOfImage`, hex-concatenated.
- Uploader-supplied fields (product, version, arch, notes) are annotations
  for browsing and filtering; they never participate in resolution.

Read path schema (exact SymSrv convention):

```text
GET /symbols/<debug_file>/<debug_id>/<debug_file>
GET /symbols/<code_file>/<code_id>/<code_file>          (deferred with exe)
```

Casing is preserved exactly as ingested (Microsoft's servers are
case-insensitive; some third-party tooling is not — we stay literal). No
directory listing. A miss is a clean 404, which symsrv reads as "try the
next downstream server" — that makes the Microsoft public server a natural
fallback in one symbol path.

## Storage

- SQLite: `modules` and `symbol_artifacts` tables (migration 4, rebuilt by
  migration 5 for the EXE kind). `modules` carries a nullable debug
  identity pair `UNIQUE(debug_file, debug_id)` and a nullable code identity
  pair `UNIQUE(code_file, code_id)`; `symbol_artifacts` is unique on
  `(module_id, kind)`. Ingest is an UPSERT-no-op returning the existing row —
  re-uploading the same identity is cheap and idempotent.
- Vault: a `symbols/` subtree keyed by a server-generated `artifactId`,
  with the same staging → promote crash-safety as dump intake. Bytes stay
  out of SQLite, honoring the existing rule.
- Artifacts are **exempt from dump retention**: no automatic purge. Operator
  purge is explicit, and the confirmation shows how many dumps reference the
  module (report-only; never blocked).

## Ingest (operator surface)

- New **Symbols** page in the operator UI: artifact list with module
  metadata, and a multi-file ingest drop zone (reusing the batch-upload
  queue component). After ingest, each file shows its parsed identity —
  "electron.pdb 3A9C…1 registered (214 MB)" or the rejection reason.
- API follows the raw-stream convention (no multipart, no base64):

```text
POST /api/v1/symbols
Content-Type: application/octet-stream
X-Symbol-Filename-Base64url: <UTF-8 filename>
→ 201 { artifactId, debugFile, debugId, kind, byteSize, sha256 }
→ 422 symbol_identity_unreadable (not a PDB / no RSDS record)
→ 409 symbol_kind_unsupported (exe in v1)
```

Operator session + CSRF like every mutation. Per-artifact size ceiling
(default 8 GiB) enforced while streaming; a new
`symbols_ingest_in_progress` guard bounds concurrent ingests to 1 (PDBs are
large; LAN ingest is operator-paced).

## Read serving (symsrv route)

```text
GET /symbols/:name/:id/:file
```

- Maps `(name, id)` → artifact via SQLite lookup, then streams from the
  vault. No engine command, no audit event per fetch (debuggers issue many
  serial requests); responses carry `Cache-Control: public, max-age=31536000`
  (artifacts are immutable per identity).
- Traversal-guarded (`:name`/`:id`/`:file` validated against the store path
  grammar; no `..`, no separators beyond the three segments).
- **Auth decision (open question 1)**: symsrv.dll cannot carry session
  cookies or CSRF headers, so the route is either LAN-open (read-only,
  no listing, nothing but symbol bytes) or fronted by an IP allowlist at the
  TLS proxy. The security model section records the decision explicitly.
- HTTPS caveat: `symsrv.dll` trusts only certs chaining to a trusted root on
  the analysis machine. Options: import the proxy's self-signed cert into
  the analyst box's root store, or serve this route plain-HTTP on the LAN
  interface. Both are documented; the route itself is transport-agnostic.
  **Resolved 2026-09-18 by the dedicated symbols listener**
  (`DUMP_LEDGER_SYMBOLS_PORT`, default off): the same store on a separate,
  plain-HTTP, read-only socket whose only route is the store path (see
  security-model.md, "Dedicated symbols listener"). The shared HTTPS route
  remains for symmetry.

## Dump ↔ symbol linkage

The minidump inspector already parses the module list (name, base, size,
timestamp); this design extends module parsing to each module's CvRecord
(RSDS) so intake facts gain `debugFile`/`debugId` per module.

- `inspection_facts.modules[]` gains `debugFile`, `debugId` (absent for
  modules without a usable CodeView record).
- Dump detail shows a **symbol coverage** section: per module —
  ✓ present in the store (with artifact link), — absent. A "Microsoft
  downstream" hint for `*.pdb` names matching well-known OS modules is
  acceptable but not required in v1.
- Case page aggregates the missing identities across its dumps so the
  operator sees exactly which builds need ingestion.
- Report-only: symbol presence never gates `AcceptDump` and never affects
  the dump lifecycle. Symbols are an analysis aid, not intake policy.

## Security model

- Mutation surfaces (ingest, purge) require the operator session and CSRF;
  the read route's exposure is decided per the auth decision above and
  documented in `security-model.md`.
- Identity is parsed from bytes; client-supplied filenames are display-only
  and bounded like dump filenames.
- Ingest streams with the same bounded-memory discipline as dump upload;
  the artifact ceiling is enforced mid-stream.
- No directory listing on the store path; misses are indistinguishable 404s.
- Purge removes the vault object and row in one transaction; referencing
  dumps keep their recorded (now-unresolvable) module facts.

## Formal model

`specs/DumpLedger.tla` gains module/artifact slots and actions:

- `IngestSymbol(m)` — enabled when the artifact identity is absent or
  already present (idempotent: re-ingest leaves state unchanged);
- `PurgeSymbol(m)` — removes the artifact;
- Invariants: artifact identity uniqueness, no duplicate
  `(debug_file, debug_id, kind)` pairs, ingest idempotence
  (`IngestSymbol; IngestSymbol` ≡ `IngestSymbol`), and dump module facts
  never reference artifacts that were never ingested (references are to
  identities, which may be absent — never to phantom rows).

Model-interface bindings and MBT traces are regenerated as a maintainer
action, listed separately in the PR, per AGENTS.md.

## Test plan

- **Unit**: RSDS parser (synthetic PDB fixtures plus one checked-in
  minimal real PDB), PE header parser, store-path encoder/decoder round
  trips (including GUID byte-order), idempotent ingest, ceiling mid-stream
  rejection.
- **Integration**: ingest → symsrv fetch returns byte-identical content and
  immutable cache headers; miss → 404; traversal attempts → 400/404; dedup
  returns the original artifactId; purge then fetch → 404.
- **Contract**: ingest response decode/encode round trips; error codes.
- **Debugger evidence (manual/CI script)**: `symchk` or CDB
  `!sym noisy; .reload /f` against a running instance resolves an ingested
  PDB from the route — the ground-truth test of the path schema.
- **Frontend (Vitest)**: Symbols page ingest queue, per-file identity
  results, dump-detail coverage rendering.
- **E2E (Playwright)**: operator ingests a PDB, uploads a dump whose module
  list references it, dump detail shows ✓ coverage.
- **MBT**: regenerated traces cover IngestSymbol idempotence and PurgeSymbol.

## Compatibility and migration safety

Purely additive. Migration 4 adds `modules` and `symbol_artifacts`; existing
rows and grants are untouched. The vault gains a `symbols/` subtree — no
collision with dump object naming. Rolling back to a pre-symbols build is
safe (the tables and subtree simply go unread); symbols ingested before
rollback are not lost and reappear after re-upgrade. Deployment follows the
same discipline as the batch-upload rollout: stop, back up `ledger.sqlite`,
boot (migration runs), verify.

## Alternatives considered and rejected

- **Standalone static symbol server** (discussed previously): loses the
  dump↔symbol linkage, doubles the auth/audit/backup surface, and still
  needs an ingest discipline. The route inside DumpLedger is the same
  static-file semantics with management value added.
- **Reuse upload grants for symbol ingest**: grants are customer-facing,
  case-bound, and slot-limited; symbols are operator/release artifacts with
  an unrelated lifecycle. Separate surface.
- **symstore-tree import** (point the server at a `symstore`-produced
  directory): a legitimate bulk-ingest path for phase 3, but it trusts
  on-disk identity naming; v1 parses identity from bytes.
- **Blocking availability on symbol presence**: symbols are analysis aids;
  coupling them to the dump lifecycle would reject perfectly good dumps.

## Implementation milestones

1. **Symbols in one place** (done 2026-09-16, commit 2d40371): entities +
   migration 4 + vault namespace + RSDS/PE parsers + ingest route + Symbols
   UI + symsrv read route + debugger-evidence test + TLA
   actions/invariants + transfer-spec repair + dual-spec model-interface
   regen.
2. **Linkage** (done 2026-09-18, commit 1ede4a5): CvRecord extraction at
   intake (best-effort per module; never gates acceptance) + per-module
   coverage on dump detail + missing-identity aggregation on case pages.
   Dumps accepted before this milestone carry facts without debug
   identities and render their modules as "unidentified" until
   re-inspected; there is no retroactive backfill.
3. **Scale-out** (done 2026-09-18): transfer-bundle `--include-symbols`
   flag (commit 849d47f; default off; importer re-ingests through the
   engine symbol path; DumpLedgerTransfer.tla + traces regenerated);
   EXE artifact kind (commit 6311894; supersedes D2; migration 5 adds the
   code-identity pair and widens the kind set; the symsrv route resolves
   either identity); CI ingest token (bearer alternative on the ingest
   route only, `DUMP_LEDGER_INGEST_TOKEN_HASH`, audit-attributed — see
   security-model.md). Deferred as designed-optional: Breakpad `.sym`
   generation. Transfer bundles carry PDB payloads only; EXE metadata
   travels in the ledger copy.

## Resolved decisions (2026-09-16)

- **D1 Read route exposure: LAN-open on the private interface.** symsrv.dll
  cannot authenticate; the route is read-only, serves no listing, and exposes
  nothing but immutable symbol bytes. A proxy IP allowlist can be added later
  without moving the route.
- **D2 PDB-first.** Chosen for v1 because CDB's normal minidump workflow
  needs only PDBs; **superseded 2026-09-18** when milestone 3 added the EXE
  artifact kind (`.exe`/`.dll` ingest, code identity from PE bytes).
- **D3 Per-artifact ceiling: 8 GiB**, enforced mid-stream.
- **D4 Accept all PDBs, with an OS-module display hint.** Rejecting would
  guess wrong occasionally; the operator knows their builds.

## Implementation constraints (verified 2026-09-16)

- **Vault layout**: the symbols subtree lives at `<vaultRoot>/symbols/` with
  its own staging directory, kept OUTSIDE the dump `stagingRoot` — recovery
  `reconcile` scans only the dump staging root for `*.part`, and
  retention/purge/export are SQLite-driven by dumpId.
- **Route ordering**: the 3-segment symsrv route registers BEFORE the
  static-web fallback; the SPA `/symbols` page is a distinct single-segment
  path.
- **Transfer-spec repair is a scheduled step**: adding base actions and
  variables to `DumpLedger.tla` breaks `DumpLedgerTransfer.tla` (EXTENDS)
  until its UNCHANGED lists, `allVars`, and `TransferTypeOK` absorb them;
  both specs' traces/locks/coverage regenerate in the same milestone
  (precedent: the batch-upload repair).
