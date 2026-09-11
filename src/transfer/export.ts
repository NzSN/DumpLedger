/**
 * Export pipeline facade. The implementation lives in export-session.ts as a
 * two-phase session (open = snapshot + selection, run = stream + seal); this
 * module preserves the original one-shot API for the manager and tests.
 */

export {
  createExportSession,
  exportBundle,
  fileBundleTarget,
  openPreparedExport,
  prepareExport,
  type BundleTarget,
  type BundleTargetFactory,
  type ExportBundleOptions,
  type ExportSession,
  type PreparedExport,
} from "./export-session.js";
