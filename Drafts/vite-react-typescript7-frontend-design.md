# Vite 8, React 19, and TypeScript 7 frontend design

Status: design only; no frontend migration is implemented by this document.

Last reviewed: 2026-09-05.

## 1. Outcome

Replace DumpLedger's growing server-rendered template strings and embedded
browser scripts with a Vite-built React 19 application written in TypeScript 7.
Keep the existing Node.js/Fastify process as the only production process and as
the authority for authentication, authorization, validation, lifecycle
transitions, persistence, dump inspection, retention, and byte transfer.

The delivered shape is:

```text
development

browser -> Vite dev server :5173 -- /api proxy --> Fastify :4080
             |                                     |
             | React Fast Refresh                  v
             +------------------------------ lifecycle engine

production

browser -> trusted HTTPS endpoint -> Fastify
                                      |-- serves Vite build
                                      |-- handles /api/v1/*
                                      |-- streams dump bytes
                                      `-- calls lifecycle engine
```

Vite is a development and build tool. It is not a second production server.
The browser and Fastify use one origin in production, preserving simple cookie,
CSRF, Content Security Policy, and upload semantics.

## 2. Fixed decisions

1. Use React 19 client rendering with one root and route-level code splitting.
2. Use Vite 8 and `@vitejs/plugin-react`; pin exact versions in
   `pnpm-lock.yaml` during implementation.
3. Use TypeScript 7 for command-line type checking. Vite transpilation never
   substitutes for `tsc --noEmit`.
4. Keep the frontend in this repository under `frontend/`.
5. Keep shared HTTP contracts in a framework-free workspace package under
   `packages/http-contracts/`.
6. Serve the production Vite output from Fastify under the same origin.
7. Use JSON for metadata operations and raw `application/octet-stream` for dump
   uploads and downloads.
8. Keep the lifecycle engine synchronous. Browser and HTTP concerns remain
   outside the generated MirrorECMA `StateComputer` seam.
9. Use native `fetch` for JSON requests and `XMLHttpRequest` only where upload
   progress is required.
10. Use React built-ins for local state. Add no global state library in the
    initial migration.
11. Use a client router for deep links, with React Router 7 as the default
    implementation choice.
12. Reuse the current evidence-vault visual language as ordinary CSS. Add no UI
    framework, CSS-in-JS runtime, external font, analytics script, or CDN.
13. Use a single source of runtime-validated HTTP contracts. TypeScript types
    alone do not validate untrusted requests or responses.
14. Keep legacy server-rendered pages until browser parity is demonstrated,
    then remove them rather than maintaining two permanent interfaces.

## 3. Current state and reason for change

The current browser/server trust separation is sound: the browser uses HTTP and
cannot access SQLite, the vault, or the lifecycle engine. The code seam is less
clear. `src/http/server.ts` currently combines route registration,
authentication checks, input parsing, page-specific projection logic, HTML
construction, and response mapping. CSS and JavaScript live in separate files
but are exported as strings and served by Fastify.

This was proportionate for the initial interface. It becomes shallow as the
following behavior arrives:

- five explicit case-workflow transitions;
- closed-case transition affordances and grant consequences;
- case and dump search/filtering;
- grant creation and revocation feedback;
- multi-stage upload progress and terminal errors;
- retention controls derived from server time;
- operations refresh and integrity warnings;
- accessible confirmations, focus management, and responsive navigation.

React earns its cost only if the browser/Fastify interface becomes smaller and
more explicit. Moving existing template strings into JSX while preserving an
unstructured all-data snapshot would change syntax without improving the
architecture.

## 4. Module and repository shape

```text
dump-ledger/
  package.json                    # orchestration and backend package
  pnpm-workspace.yaml
  tsconfig.json                   # backend/tests/tools

  frontend/
    package.json                  # @dump-ledger/web
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.tsx
      app/
        App.tsx
        router.tsx
        SessionProvider.tsx
        ErrorBoundary.tsx
      features/
        auth/
        dashboard/
        customers/
        cases/
        grants/
        dumps/
        uploads/
        operations/
      shared/
        http-client.ts
        format.ts
        status.ts
        components/
      styles/
        tokens.css
        app.css
        responsive.css
      test/

  packages/
    http-contracts/
      package.json                # @dump-ledger/http-contracts
      tsconfig.json
      src/
        auth.ts
        cases.ts
        customers.ts
        dumps.ts
        grants.ts
        operations.ts
        uploads.ts
        errors.ts
        decode.ts
        index.ts
      test/

  src/
    http/
      contracts/                  # Fastify schema adapters only
      routes/
        auth-routes.ts
        case-routes.ts
        customer-routes.ts
        dump-routes.ts
        grant-routes.ts
        operation-routes.ts
        upload-routes.ts
      static-web.ts               # Vite build serving + SPA fallback
      server.ts                   # composition and shared hooks only
    engine/
    ledger/
    vault/
    inspection/
    intake/
    recovery/
```

`@dump-ledger/http-contracts` imports no Node, Fastify, React, DOM, filesystem,
SQLite, or engine modules. It contains serializable types, stable error codes,
and runtime decoders. Both frontend and backend depend inward on it; it depends
on neither.

The backend does not expose `DumpLedgerProjection` directly. Each query returns
the smallest page- or operation-specific representation required by the
browser.

## 5. Build and development topology

### 5.1 Workspace

Extend `pnpm-workspace.yaml` with:

```yaml
packages:
  - frontend
  - packages/*
```

The root remains the backend package. The contracts and frontend are named
workspace packages, allowing deterministic filtered builds without creating a
second repository.

### 5.2 Dependency policy

Initial browser runtime dependencies:

- `react` and `react-dom` on the React 19 line;
- `react-router` on the current compatible major.

Initial frontend development dependencies:

- Vite 8 and its matching `@vitejs/plugin-react` line;
- TypeScript 7 and React DOM type declarations;
- Vitest, React Testing Library, and `user-event`;
- Playwright for production-build browser journeys.

Pin reviewed exact versions in the lockfile. Do not enable React Compiler in the
initial migration, and do not add a query cache, global state library,
CSS-in-JS runtime, request library, or component framework without a measured
need.

### 5.3 TypeScript configuration

The frontend TypeScript configuration uses:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noEmit": true,
    "types": ["vite/client"]
  }
}
```

Vite transpiles `.ts` and `.tsx`, but it does not type-check them. Every
development and release gate therefore runs TypeScript 7 separately. TypeScript
7.0 has no stable programmatic compiler interface; tooling that imports
`typescript` may require the official TypeScript 6 compatibility package.
Introduce that compatibility package only for a concrete tool that needs it.

### 5.4 Vite configuration

Development configuration:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4080",
      "/health": "http://127.0.0.1:4080"
    }
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false
  }
});
```

Production Fastify serves `dist/web/index.html` and hashed assets. The SPA
fallback applies only to known browser routes and never converts an unknown
`/api/*`, `/health`, upload, manifest, or download request into HTML.

### 5.5 Root scripts

Target orchestration:

```json
{
  "scripts": {
    "dev:contracts": "pnpm --filter @dump-ledger/http-contracts dev",
    "dev:server:compile": "tsc -p tsconfig.json --watch",
    "dev:server:run": "node --watch dist/src/main.js",
    "dev:web": "pnpm --filter @dump-ledger/web dev",
    "typecheck:contracts": "pnpm --filter @dump-ledger/http-contracts typecheck",
    "typecheck:server": "tsc -p tsconfig.json --noEmit",
    "typecheck:web": "pnpm --filter @dump-ledger/web typecheck",
    "typecheck": "pnpm run typecheck:contracts && pnpm run typecheck:server && pnpm run typecheck:web",
    "build:contracts": "pnpm --filter @dump-ledger/http-contracts build",
    "build:server": "tsc -p tsconfig.json",
    "build:web": "pnpm --filter @dump-ledger/web build",
    "test:web": "pnpm --filter @dump-ledger/web test",
    "test:e2e": "playwright test",
    "build": "pnpm run build:contracts && pnpm run build:server && pnpm run build:web"
  }
}
```

Run the contracts watcher, backend compiler, backend process, and Vite process
as separate development tasks so failure and output remain attributable. A
later convenience runner may supervise them without changing the production
interface. Build contracts and backend output once before starting their
watchers. Release builds never depend on the Vite development server.

## 6. Browser routes

| Browser route | Audience | Purpose |
| --- | --- | --- |
| `/login` | public | Operator authentication |
| `/` | operator | Dashboard, customers, and recent cases |
| `/cases/:caseId` | operator | Case status, grants, dumps, and activity |
| `/dumps/:dumpId` | operator | Evidence facts, download, and retention |
| `/operations` | operator | Runtime health and bounded job state |
| `/upload` | grant holder | One-time public dump intake |

Unknown browser routes render a branded not-found view. Authentication failure
redirects operator routes to `/login` while retaining only a safe relative
return path. The public uploader does not load operator data or trigger the
authenticated session bootstrap.

## 7. HTTP interface

### 7.1 General rules

- Metadata endpoints live under `/api/v1`.
- Requests and responses use UTF-8 JSON unless explicitly identified as raw
  bytes.
- Identifiers are opaque strings.
- Byte sizes are decimal strings, avoiding JavaScript number truncation.
- Timestamps are canonical UTC ISO strings.
- Every JSON request is decoded at runtime before any engine call.
- Stable errors use one envelope:

```ts
type HttpErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_transition"
  | "grant_unavailable"
  | "upload_too_large"
  | "upload_busy"
  | "rate_limited"
  | "storage_unavailable"
  | "integrity_failure"
  | "internal_error";

interface ErrorResponse {
  readonly error: {
    readonly code: HttpErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}
```

- `message` is safe operator-facing text, never a filesystem path, SQL error,
  grant secret, password, dump content, or stack trace.
- Mutation success responses contain the resulting server state needed to
  render the next view. The frontend does not predict lifecycle results.
- Authenticated and grant-bearing responses use `Cache-Control: no-store`.
- The backend remains authoritative even when the frontend hides an illegal
  action.

### 7.2 Authentication

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/v1/session` | none | `{ authenticated, csrfToken?, expiresAt? }` |
| `POST /api/v1/session` | `{ password }` | Sets cookie and returns authenticated session |
| `DELETE /api/v1/session` | CSRF header | Clears cookie, returns `204` |

The password is accepted only by the login mutation. The session cookie remains
`HttpOnly`, `SameSite=Strict`, and `Secure` for an asserted HTTPS deployment.
The frontend keeps the CSRF token in memory. A reload obtains it from
`GET /api/v1/session`; it is never stored in `localStorage`, `sessionStorage`,
IndexedDB, or a non-HttpOnly cookie.

All authenticated mutations send:

```text
X-CSRF-Token: <session token>
```

Fastify also validates the browser `Origin` and Fetch Metadata headers when
present. Development permits only the configured Vite origin; production
permits only the external same origin. This supplements rather than replaces
the CSRF token.

### 7.3 Customers and dashboard

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/dashboard` | Counts, recent cases, and bounded customer summary |
| `GET /api/v1/cases?query=&cursor=` | Bounded case search and pagination |
| `POST /api/v1/customers` | Create a customer |
| `POST /api/v1/customers/:customerId/cases` | Create a `new` case |

Dashboard and search responses are bounded. The backend performs filtering and
pagination; the browser never receives the entire ledger through a global
snapshot.

### 7.4 Case workflow

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/v1/cases/:caseId` | none | Case detail, bounded grants/dumps/activity, allowed actions |
| `POST /api/v1/cases/:caseId/transitions` | `{ action }` | Resulting case state and revocation summary |
| `GET /api/v1/cases/:caseId/manifest` | none | Downloadable JSON manifest |

`action` uses the exact stable TLA+/generated-port names:

```ts
type CaseAction =
  | "StartInvestigation"
  | "WaitForCustomer"
  | "ResumeInvestigation"
  | "ResolveCase"
  | "CloseCase";
```

The case-detail response supplies `allowedActions` for presentation. That field
is guidance, not authorization. The transition command is checked again in the
lifecycle engine and transaction. `CloseCase` returns the number and identifiers
of grants atomically revoked by the transition; it never changes dump retention
or downloadability.

The frontend case transition controls remain disabled until the TypeScript
engine, SQLite transaction, generated `CaseStatus` observation, five generated
actions, MirrorECMA traces, and freshness gates implement the current
`DumpLedger.tla` revision.

### 7.5 Grants

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /api/v1/cases/:caseId/grants` | `{ validForHours, maxBytes }` | Grant metadata and one-time `uploadPath` |
| `POST /api/v1/grants/:grantId/revoke` | none | Resulting revoked state |

`uploadPath` is relative. The frontend constructs the shareable URL from
`location.origin`, avoiding trust in an attacker-controlled `Host` or forwarded
host header. The secret is returned only once and is held only in route-local
memory until the operator navigates away.

### 7.6 Public upload

Prefer a fragment-bearing share URL:

```text
https://dump-ledger.example/upload#grant=<base64url-secret>
```

URL fragments are not sent in the initial HTTP request and therefore avoid the
normal request-target and reverse-proxy access logs. The uploader reads the
secret into memory and removes the fragment with `history.replaceState`. It
sends the bearer value only in the upload request header:

```text
POST /api/v1/uploads
Content-Type: application/octet-stream
X-Upload-Grant: <base64url-secret>
X-Dump-Filename-Base64url: <UTF-8 filename encoded as base64url>
```

The filename encoding supports Unicode without placing non-ByteString values in
an HTTP header. The backend bounds the decoded filename independently of the
header length and falls back to `upload.dmp` on invalid input.

The file object is sent directly with `XMLHttpRequest.send(file)`. It is never
read into an `ArrayBuffer`, encoded as base64, inserted into JSON, or copied into
React state. Progress comes from `xhr.upload.progress`.

Successful responses retain the current meanings:

- `201`: sealed and post-processed to `available` or `rejected`;
- `202`: bytes sealed, with processing `retry-queued` or
  `recovery-required`;
- `404`: grant unavailable without revealing whether it was unknown, revoked,
  expired, consumed, or blocked by a closed case;
- `413`: upload exceeded the grant's original-byte limit;
- `503`: admission or storage unavailable, with a safe retry policy.

Once the request starts, the grant may be consumed even if the browser aborts
or loses the network. The UI explains this before upload, disables automatic
retry, and directs the customer to request a new link after an uncertain
outcome.

Existing path-secret links may be accepted only during a bounded migration
window no longer than their maximum grant lifetime. New links use fragments.

### 7.7 Dumps, retention, and operations

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/v1/dumps/:dumpId` | none | Lifecycle, coverage, facts, retention, and activity |
| `GET /api/v1/dumps/:dumpId/content` | none | Raw immutable `.dmp` stream |
| `PUT /api/v1/dumps/:dumpId/retention` | `{ days }` | Server-clock-derived canonical deadline |
| `GET /api/v1/operations` | none | Integrity, admission, queue, and job summaries |
| `GET /health` | none | Minimal unauthenticated process health |

Retention accepts a bounded integer number of days. Fastify computes the
deadline from its current server clock and sends the absolute timestamp to the
lifecycle engine. The browser clock and timezone are never authoritative.

Downloads remain ordinary navigations so the browser can stream directly to
disk. The React application does not buffer dump content.

## 8. Frontend modules

### 8.1 HTTP client

`shared/http-client.ts` is a deep module with a small interface:

```ts
interface DumpLedgerHttpClient {
  query<T>(request: QueryRequest<T>, signal?: AbortSignal): Promise<T>;
  mutate<T>(request: MutationRequest<T>, signal?: AbortSignal): Promise<T>;
  upload(request: UploadRequest, observer: UploadObserver): UploadHandle;
}
```

Its implementation owns credentials, CSRF headers, JSON encoding/decoding,
runtime response validation, stable error conversion, request cancellation,
401 session invalidation, and upload progress. Feature modules never call
`fetch` or `XMLHttpRequest` directly. It does not automatically retry mutations
or uploads; callers refetch authoritative state after an uncertain result.

### 8.2 Session state

`SessionProvider` owns only authenticated session state and the in-memory CSRF
token. It does not own cases, dumps, grants, or operations data. A 401 clears
session state and moves the user to login; a 403 remains a visible authorization
or CSRF error rather than being treated as logout.

### 8.3 Server data

The URL is the source of navigation state. Each route loads its own bounded
server representation and refetches after successful mutations. Avoid a global
copy of the ledger and avoid optimistic lifecycle transitions. Local optimistic
feedback is limited to presentation state such as disabling a submitted button.

Requests are abortable when routes change. Older responses cannot overwrite a
newer route state. Operations polling pauses while the document is hidden and
never overlaps an outstanding request.

### 8.4 Shared presentation

Shared presentation modules include navigation, panel, status pill, empty
state, form field, notice, confirmation dialog, byte/timestamp formatting, and
error display. Domain-specific screens compose these modules without adding a
generic design-system dependency.

Use semantic HTML and native controls. Every mutation has a visible pending,
success, and failure state. Focus moves to the result or error summary after a
mutation. Keyboard and screen-reader behavior are acceptance requirements.

## 9. Security and privacy

Production responses use a Content Security Policy compatible with Vite's
external hashed modules:

```text
default-src 'self';
script-src 'self';
style-src 'self';
connect-src 'self';
img-src 'self' data:;
font-src 'self';
object-src 'none';
frame-ancestors 'none';
base-uri 'none';
form-action 'self'
```

Additional rules:

- Emit no inline executable script and no runtime style injection.
- Keep `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.
- Serve hashed assets with long-lived immutable caching.
- Serve `index.html`, authenticated JSON, grant results, and dump metadata with
  `no-store` or `no-cache` as appropriate.
- Register no service worker; sensitive responses must not enter an offline
  cache.
- Call no third-party origin at runtime.
- Use no `dangerouslySetInnerHTML` for customer or dump metadata.
- Redact authorization, cookie, CSRF, grant, and upload headers from logs.
- Never log the complete browser location or fragment.
- Ensure reverse-proxy access logs cannot record newly issued grant secrets.
- Preserve download authorization and `Content-Disposition` protections on the
  backend.
- Keep development HMR policy separate; production CSP never permits the Vite
  development origin or WebSocket.

React reduces manual interpolation mistakes but is not an authorization or XSS
control. Runtime decoding, output encoding, CSP, and backend checks remain
required.

## 10. Backend refactor required by the seam

The frontend migration should deepen the HTTP module rather than layer JSON
routes beside the existing global projection forever.

1. Split route registration by domain while keeping `buildHttpServer` as the
   composition interface.
2. Replace `HttpApplicationPort.snapshot()` with bounded query methods for
   dashboard, case detail, dump detail, search, and operations.
3. Move JSON runtime decoding into shared contracts plus thin Fastify schema
   adapters.
4. Keep all lifecycle decisions in engine commands and ledger transactions.
5. Keep upload streaming connected directly to `UploadSession`; React metadata
   routes never own byte flow.
6. Keep static-file and SPA fallback handling isolated in `static-web.ts`.
7. Delete server-side HTML rendering only after React route parity and browser
   tests pass.

The `HttpApplicationPort` name may remain during migration, but its final
interface should express browser use cases rather than exposing the entire
domain projection.

## 11. Migration sequence

### Phase 0 — restore lifecycle conformance

Implement the specification-only case workflow through the existing required
path: engine and SQLite behavior, generated `CaseStatus` observation and five
case actions, MirrorECMA traces, generated binding, and freshness gates.

Completion criterion: `check:model-interface`, MBT, TLC, Apalache, unit, and
integration gates are green before React exposes case-transition controls.

### Phase 1 — contracts and JSON routes

Create the framework-free contract package and authenticated JSON routes while
retaining current HTML routes. Add request/response decoding, CSRF header
support, stable errors, bounded page queries, and integration tests.

Completion criterion: every proposed endpoint has positive, malformed,
unauthenticated, unauthorized, and illegal-transition coverage; no route sends
an engine projection directly.

### Phase 2 — Vite and application shell

Create the React/Vite package, routing, session bootstrap, error-handling module,
navigation, existing CSS tokens, and production asset serving. Initially mount
the React application under a development-only `/app` route so current pages
remain the comparison oracle.

Completion criterion: login, logout, reload, deep link, expired session,
not-found, keyboard navigation, production build, and production CSP tests pass.

### Phase 3 — operator features

Migrate dashboard, customers, cases, case transitions, grants, dump details,
retention, downloads, and operations. Server-returned allowed actions drive
presentation; backend transitions remain authoritative.

Completion criterion: every current operator flow and every new case transition
passes frontend-module, contract, integration, and real-browser tests.

### Phase 4 — public uploader

Migrate the public uploader, introduce fragment/header grant transport, preserve
raw streaming, and cover selection, drag/drop, progress, oversize, disconnect,
invalid grant, rejected dump, queued processing, and accessibility behavior.

Completion criterion: a real browser uploads a synthetic minidump through the
production Fastify byte path without buffering or base64 conversion, and replay
fails closed.

### Phase 5 — cutover and deletion

Serve React at the final browser routes, remove old template/script/style string
modules, remove transitional path-secret support after its bounded window, and
prune duplicate tests and contracts.

Completion criterion: there is one browser interface, one HTTP contract source,
one production process, no old renderer reachable, and the aggregate release
gate is green from a clean checkout.

## 12. Testing strategy

### Contract tests

- Round-trip every valid request and response representation.
- Reject missing, extra, duplicate, malformed, oversized, and wrong-type data.
- Verify bigint values cross the seam only as canonical decimal strings.
- Verify timestamps are canonical UTC values.
- Verify stable error codes and safe messages.

### Frontend tests

Use Vitest and React Testing Library for rendering, state, focus, and interaction
tests. Test through accessible roles and labels. Replace the HTTP client with a
fake adapter rather than mocking global `fetch` in each feature.

### Backend integration tests

Use Fastify injection for JSON validation, cookies, CSRF, case transitions,
grant consequences, server-clock retention, cache headers, and response shapes.
Continue using real SQLite and vault adapters where existing tests do.

### Browser tests

Use Playwright against the production Vite build served by Fastify. Required
journeys:

1. Login, reload, and logout.
2. Create customer and case.
3. Exercise every legal case transition and reject illegal/repeated actions.
4. Create and copy a one-time upload link.
5. Upload a synthetic minidump through the public page and show progress.
6. Verify the dump becomes available or explicitly rejected.
7. Download original bytes and compare them exactly.
8. Set retention and verify the deadline derives from server time.
9. Close a case, verify issued grants are revoked, and verify existing dumps
   remain downloadable according to dump state.
10. Check keyboard navigation and narrow/desktop layouts.

### Security checks

- No third-party requests from login, operator, or upload pages.
- No grant secret in request targets, console output, error reports, or access
  logs after the migration window.
- No inline script accepted by production CSP.
- No authenticated response cached by a service worker or shared cache.
- No state-changing request succeeds without valid session and CSRF evidence.
- No browser manipulation can bypass an engine transition guard.

## 13. Release gates

The final aggregate gate includes:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run check:model-interface
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:mbt
pnpm run test:web
pnpm run test:e2e
```

Additional acceptance:

- Vite production build contains no unexpected external origin.
- Initial operator route JavaScript remains within a reviewed compressed bundle
  budget; the public uploader is independently code-split and measured.
- Fastify starts successfully with only production dependencies and built
  assets.
- A clean production start serves deep links without turning unknown `/api`
  paths into HTML.
- Existing dump data remains readable and downloadable after migration.
- The generated model-interface tree is changed only by
  `model_interface_gen`.

## 14. Task ownership

The work can be assigned without overlapping file ownership:

1. **Lifecycle prerequisite** — own `specs/`, `model-interface/`, generated
   binding, `src/engine/`, case-related ledger methods, MBT adapter/traces, and
   their tests. Deliver a green conformance gate before UI transition controls.
2. **HTTP contracts** — own `packages/http-contracts/`, backend contract
   adapters, and JSON contract tests. Publish the stable browser/Fastify
   interface without frontend presentation.
3. **Frontend shell** — own `frontend/src/app/`, routing, session handling,
   shared HTTP client, CSS migration, and frontend test configuration.
4. **Operator features** — own React customer, dashboard, case, grant, dump,
   retention, and operations features against the shared client interface.
5. **Public uploader** — own React upload UI, raw XHR adapter, fragment grant
   handling, progress/error semantics, and uploader browser tests.
6. **Fastify cutover** — own route decomposition, static production serving,
   CSP/cache behavior, legacy renderer deletion, and full browser integration.
7. **Independent review** — verify secrets/logging, runtime validation, browser
   buffering, stale generated artifacts, full gates, clean install, and final
   destination-tree status.

Each owner works around concurrent edits and does not rewrite another owner's
files. Shared contract changes are coordinated through the HTTP-contract owner.

## 15. Rejected alternatives

### Separate frontend repository

Rejected because contracts, versions, tests, and releases would drift while the
product still ships as one process.

### Separate production Vite server

Rejected because it creates unnecessary CORS, cookie, CSRF, deployment, and
failure-mode complexity. Fastify serves the built files.

### React Server Components or a full-stack React framework

Rejected because DumpLedger already has a deliberate Fastify/engine
architecture, needs no SEO rendering, and gains no useful capability from a
second server abstraction.

### Preserve server-rendered pages indefinitely

Rejected because two interfaces double security review, behavior parity, and
test burden. Legacy rendering is temporary migration scaffolding only.

### JSON or base64 dump uploads

Rejected because encoding increases size and risks complete-file buffering.
The byte stream remains the byte stream.

### Frontend lifecycle rules

Rejected because duplicated transition logic will drift from TLA+, the engine,
and SQLite. The frontend renders server-provided allowed actions and treats
server rejection as authoritative.

## 16. External compatibility references

- React 19 is stable and React's current documentation tracks the React 19
  line: <https://react.dev/versions>.
- Vite provides a React TypeScript template and documents its Node requirements:
  <https://vite.dev/guide/>.
- Vite documents React Fast Refresh, TypeScript transpilation, and the required
  separate type-checking step: <https://vite.dev/guide/features.html>.
- Vite documents integration with a traditional backend and production build
  manifests: <https://vite.dev/guide/backend-integration.html>.
- TypeScript 7.0 is the native production release; its lack of a stable
  programmatic compiler interface and TypeScript 6 compatibility option are
  documented at
  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>.

Re-check exact package releases and peer ranges immediately before modifying
the lockfile. Pin reviewed versions rather than copying floating `latest`
examples into production configuration.
