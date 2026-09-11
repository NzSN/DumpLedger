/**
 * Import pipeline facade. The implementation lives in import-session.ts as a
 * stepwise session (open = validate, per-record steps, finish/abandon); this
 * module preserves the original one-shot API for the manager and tests.
 */

export {
  importBundle,
  openImportSession,
  type BundleDumpRow,
  type BundleRows,
  type Counters,
  type ImportBundleOptions,
  type ImportDumpDisposition,
  type ImportOutcome,
  type ImportSession,
} from "./import-session.js";
