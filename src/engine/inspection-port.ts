import type { DumpId } from "../domain/ids.js";
import type { CoverageKind } from "../domain/lifecycle.js";
export type InspectionOutcome =
  | { readonly ok: true; readonly coverage: CoverageKind; readonly facts: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };
export interface InspectionPort { inspect(dumpId: DumpId): InspectionOutcome }
