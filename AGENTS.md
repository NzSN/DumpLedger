# Repository Guidelines

DumpLedger is a self-hosted intake ledger for Windows minidumps: a TypeScript 7 / Node.js 24 service (Fastify + SQLite + filesystem vault) with a Vite/React frontend and a TLA+ model driving model-based tests.

## Project Structure & Module Organization

- `src/` — backend source, one folder per module (`auth`, `domain`, `engine`, `http`, `intake`, `ledger`, `vault`, `recovery`, `inspection`, `mbt`, `generated`); entry point `src/main.ts`.
- `test/unit/`, `test/integration/`, `test/mbt/` — node:test tiers; fixtures in `test/fixtures/`.
- `e2e/` — Playwright journeys run against the production build.
- `frontend/` — `@dump-ledger/web` React app; `packages/http-contracts/` — shared HTTP contracts (both pnpm workspace packages).
- `specs/` — TLA+ model and MBT witnesses; `model-interface/` — generated interface, lock, and coverage files.
- `docs/` — design documents; `tools/` — codegen and secret scripts; `dist/` — gitignored build output.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` — install dependencies (pnpm 11.5.1, Node 24).
- `pnpm run typecheck` / `pnpm run build` — typecheck everything; build contracts and web, then compile the backend to `dist/`.
- `pnpm run test:unit` / `test:integration` / `test:mbt` — run one tier against compiled output (build first); `pnpm run test:web` — frontend Vitest; `pnpm run test:e2e` — Playwright e2e.
- `pnpm run check:model-interface` — verify generated bindings match the TLA+ spec.
- `pnpm test` — full gate: typecheck, model-interface check, build, then all three tiers.
- `npm start` — run the server; see README for required `DUMP_LEDGER_GRANT_KEY` / `DUMP_LEDGER_OPERATOR_PASSWORD_HASH` setup.

## Coding Style & Naming Conventions

- Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); ES2023, NodeNext modules. Relative imports use explicit `.js` extensions (e.g., `"../domain/ids.js"`).
- Use the vocabulary in `CONTEXT.md`: **Case** (not ticket), **case workflow** states (`new` … `closed`), **dump lifecycle**, **upload grant**.
- No formatter/linter is configured; match the surrounding file's style.

## Testing Guidelines

- Tests use `node:test` (`describe`/`it`) with `node:assert/strict`; name files `*.test.ts` (e2e: `*.spec.ts`).
- Tests execute from `dist/` — build first, or just run `pnpm test`.
- MBT traces are checked-in generated evidence; regenerating them (`pnpm run generate:mbt-traces`) is an explicit maintainer action, never part of fixing a failing test.

## Commit & Pull Request Guidelines

- Commits use a short imperative summary, optionally area-prefixed (e.g., `Docs:`), with a body describing the phases or rationale.
- PRs name the design doc or milestone implemented, confirm `pnpm test` passes, and list regenerated model-interface or trace artifacts separately.

## Security & Configuration Tips

- Never commit secrets or `/data/` (gitignored). Keep the grant key stable across restarts and backed up separately from the SQLite file.
- Dump bytes live only in the vault; SQLite holds metadata and associations only.
