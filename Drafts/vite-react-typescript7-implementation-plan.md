# Vite/React/TypeScript frontend implementation plan

Status: implemented (all waves complete, release gate green 2026-09-06). Source design: `Drafts/vite-react-typescript7-frontend-design.md`
(2026-09-05). This plan sequences that design into delegable tasks with
non-overlapping write sets and explicit completion gates.

Last reviewed: 2026-09-06.

## 0. Verified starting state

Established by direct inspection on 2026-09-06:

- `specs/DumpLedger.tla` already models the full case workflow: `CaseStatuses`,
  the five actions (`StartInvestigation`, `WaitForCustomer`,
  `ResumeInvestigation`, `ResolveCase`, `CloseCase`), and closure-time grant
  revocation.
- Nothing downstream implements it: `model-interface/*.json`, the generated
  TypeScript binding, `src/engine/commands.ts`, the engine, the SQLite ledger,
  and `src/http/server.ts` contain no case-transition support. `CaseStatus`
  exists only as a domain type and projection field.
- `specs/README.md` declares the checked-in model interface and MBT traces
  intentionally stale until runtime and generated artifacts refresh together.
- The model-interface compiler `model_interface_gen` is a `lean_exe` target in
  `/home/nzsn/Repos/Mirrors` but is not currently built; `tlc` and
  `apalache-mc` are installed.
- Current HTTP surface is one 452-line `src/http/server.ts` mixing routing,
  auth, HTML string views (`src/http/views/`), and a global
  `HttpApplicationPort.snapshot()` projection. No `frontend/` or `packages/`
  directories exist yet; `pnpm-workspace.yaml` has no `packages:` field.

## 1. Workstreams and waves

Dependencies follow the design's migration sequence. Waves run sequentially;
tasks inside a wave run in parallel with disjoint write sets.

```text
wave 1:  T1 lifecycle conformance   |  T2 http-contracts package
wave 2:  T3 backend JSON routes     |  T4 frontend shell
wave 3:  T5 operator features       |  T6 public uploader
wave 4:  T7 Fastify cutover + deletion
final:   T8 independent review (orchestrator-run, not delegated)
```

T3 depends on T1 (transition commands) and T2 (contracts). T4 depends on T2.
T5 and T6 depend on T3 and T4. T7 depends on T5 and T6.

## 2. Task definitions

### T1 — Phase 0: restore lifecycle conformance

Owns: `specs/mbt/`, `model-interface/`, `src/generated/`,
`src/domain/lifecycle.ts`, `src/engine/`, `src/ledger/`, `src/mbt/`,
`test/mbt/`, `test/fixtures/mbt/`, `test/integration/engine-lifecycle.test.ts`,
`tools/generate-mbt-traces.ts`, `specs/README.md`, `docs/formal-model.md`.

Work:

1. Build `model_interface_gen` in `/home/nzsn/Repos/Mirrors`
   (`lake build model_interface_gen`).
2. Regenerate `model-interface/` contract, lock, and coverage for the current
   `DumpLedger.tla` revision via `tools/check-model-interface.sh` machinery.
3. Regenerate the TypeScript binding under `src/generated/dump-ledger/` only
   through `model_interface_gen`.
4. Implement the five case-transition commands in the engine with
   `CloseCase` atomically revoking all issued grants for the case and never
   changing dump retention or downloadability. Keep the engine synchronous.
5. Persist case status transitions in the SQLite ledger inside ledger
   transactions; extend migrations and audit events.
6. Regenerate MBT traces through `runClientGenTraces` (Apalache) so every
   action, including the five case actions, has coverage; refresh the coverage
   report and negative fixtures as needed.
7. Extend engine lifecycle integration tests for every legal and illegal
   transition, including closed-case grant consequences.

Gate: `pnpm run typecheck`, `pnpm run check:model-interface`,
`pnpm run build`, `pnpm run test:unit`, `pnpm run test:integration`,
`pnpm run test:mbt` all green; TLC and bounded Apalache checks per
`specs/README.md` pass.

### T2 — Phase 1a: HTTP contracts package

Owns: `packages/http-contracts/`, `pnpm-workspace.yaml`, root `package.json`
(contracts scripts only).

Work:

1. Create `@dump-ledger/http-contracts` as a framework-free workspace package:
   serializable request/response types, stable error codes, and runtime
   decoders for auth, customers, cases, grants, dumps, uploads, and
   operations, per design section 7.
2. `CaseAction` uses the exact generated-port names: `StartInvestigation`,
   `WaitForCustomer`, `ResumeInvestigation`, `ResolveCase`, `CloseCase`.
3. The package imports no Node, Fastify, React, DOM, filesystem, SQLite, or
   engine modules; enforce with a test or boundary check.
4. Contract tests: round-trip every valid representation; reject missing,
   extra, duplicate, malformed, oversized, and wrong-type data; bigint only as
   canonical decimal strings; timestamps as canonical UTC.
5. Add `packages:` to `pnpm-workspace.yaml` and contracts scripts to the root
   `package.json` per design section 5.5.

Gate: contracts typecheck and contract tests green from a clean install.

### T3 — Phase 1b: backend JSON routes

Depends on: T1, T2.
Owns: `src/http/routes/`, `src/http/contracts/`, `src/http/application.ts`,
`src/http/server.ts`, `test/integration/http-routes.test.ts` (and new JSON
route test files under `test/integration/`).

Work:

1. Split route registration by domain (`auth-routes.ts`, `case-routes.ts`,
   `customer-routes.ts`, `dump-routes.ts`, `grant-routes.ts`,
   `operation-routes.ts`, `upload-routes.ts`) with `buildHttpServer` remaining
   the composition interface; keep existing HTML routes working.
2. Add `/api/v1/*` JSON endpoints per design section 7, decoding requests and
   encoding responses through `@dump-ledger/http-contracts` plus thin Fastify
   schema adapters in `src/http/contracts/`.
3. Replace `snapshot()` usage for browser data with bounded page/operation
   query methods on the application port (dashboard, case detail with
   `allowedActions`, dump detail, search, operations). No route sends an
   engine projection directly.
4. Add CSRF header support for mutations; keep session cookie semantics.
5. Accept `X-Upload-Grant` and `X-Dump-Filename-Base64url` upload headers
   alongside the legacy path secret; bound the decoded filename and fall back
   to `upload.dmp`; keep upload streaming wired directly to `UploadSession`.
6. Retention endpoint computes the deadline from the server clock.
7. Case transition endpoint delegates to engine commands; illegal transitions
   return stable errors.

Gate: every endpoint has positive, malformed, unauthenticated, unauthorized,
and illegal-transition integration coverage using Fastify injection.

### T4 — Phase 2: frontend shell

Depends on: T2.
Owns: `frontend/`, root `package.json` web/e2e scripts.

Work:

1. Scaffold `@dump-ledger/web` with Vite 8, `@vitejs/plugin-react`, React 19,
   TypeScript 7, React Router 7; pin exact versions in `pnpm-lock.yaml`.
2. Apply the design's `tsconfig` (strict, `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`, `noEmit`) and Vite config (dev proxy
   `/api` + `/health` to `127.0.0.1:4080`, build to `dist/web`, no sourcemap).
3. Implement `app/` (App, router, SessionProvider, ErrorBoundary), the deep
   `shared/http-client.ts` (`query`/`mutate`/`upload`; owns credentials, CSRF
   header, runtime validation via contracts, 401 handling, abort; XHR only for
   upload progress), and shared presentation modules.
4. Migrate the evidence-vault CSS from `src/http/views/app.css.ts` into
   `frontend/src/styles/` as ordinary CSS. No UI framework, CSS-in-JS,
   external font, or CDN.
5. Vitest + React Testing Library + user-event setup with a fake HTTP-client
   adapter (no per-feature `fetch` mocks).

Gate: `typecheck:web`, `test:web`, `build:web` green; login, logout, reload,
deep link, expired session, not-found, and keyboard navigation tests pass
against the fake adapter.

### T5 — Phase 3: operator features

Depends on: T3, T4.
Owns: `frontend/src/features/dashboard/`, `customers/`, `cases/`, `grants/`,
`dumps/`, `operations/`, and their tests.

Work: migrate every operator flow (dashboard, customers, cases, the five case
transitions driven by server-returned `allowedActions`, grants with one-time
`uploadPath` display built from `location.origin`, dump details, retention,
downloads as plain navigations, operations polling that pauses when hidden).
Refetch after mutations; no optimistic lifecycle transitions; abortable
requests on route change.

Gate: every current operator flow and every case transition passes
frontend-module, contract, integration, and real-browser tests.

### T6 — Phase 4: public uploader

Depends on: T3, T4.
Owns: `frontend/src/features/uploads/` and its tests.

Work: fragment-bearing share URL (`/upload#grant=<base64url-secret>`), read
secret into memory, `history.replaceState` fragment removal, raw
`XMLHttpRequest.send(file)` streaming with `xhr.upload.progress`, base64url
filename header, no ArrayBuffer/base64/JSON conversion of bytes, no automatic
retry, pre-upload consumption warning, full progress/error/terminal-state
semantics per design section 7.6, accessibility coverage.

Gate: a real browser uploads a synthetic minidump through the production
Fastify byte path without buffering or base64 conversion; replay fails closed.

### T7 — Phase 5: Fastify cutover and deletion

Depends on: T5, T6.
Owns: `src/http/static-web.ts`, `src/http/server.ts`, `src/http/views/`
(deletion), `src/main.ts` wiring, CSP/cache header handling, e2e Playwright
configuration.

Work: serve `dist/web` from Fastify with SPA fallback restricted to known
browser routes (never `/api/*`, `/health`, upload, manifest, or download);
production CSP per design section 9; immutable caching for hashed assets,
`no-store` for `index.html` and authenticated JSON; mount React at final
routes; delete `src/http/views/` and legacy upload path-secret support after
the bounded migration window; prune duplicate tests.

Gate: one browser interface, one contract source, one production process, no
old renderer reachable, aggregate release gate green from a clean checkout.

### T8 — independent review

Run by the orchestrator after T7: secrets/logging audit, runtime validation
spot checks, browser buffering checks, stale generated-artifact check, full
release gate, clean-install verification, destination-tree status.

## 3. Cross-task rules

- Each owner works around concurrent edits and never rewrites another owner's
  files. Shared contract changes go through the T2 owner.
- The generated tree under `src/generated/` changes only through
  `model_interface_gen`.
- `pnpm install --frozen-lockfile` must pass at every wave boundary.
- Vite transpilation never substitutes for `tsc --noEmit`; every gate runs
  TypeScript separately.
- No React Compiler, query cache, global state library, CSS-in-JS, request
  library, or component framework without a measured need.
