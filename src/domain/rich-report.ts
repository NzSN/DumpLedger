import { createHash } from "node:crypto";
import { DumpLedgerError } from "./errors.js";

/** Schema rules mirror DumpAnalyzer src/report.rs. Runtime-neutral and shared by decoders. */
export const MAX_RICH_REPORT_BYTES = 512 * 1024;
export const MAX_RICH_ANALYSIS_REQUEST_BYTES = 1024 * 1024;
export const MAX_RICH_FRAMES = 128;
export const MAX_RICH_MODULES = 64;
export const MAX_RICH_EVIDENCE = 32;

export function richUtf8Bytes(value: string): number {
  let count = 0;
  for (const c of value) { const n = c.codePointAt(0)!; count += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4; }
  return count;
}
type RichObject = Record<string, unknown>;
function badRich(): never { throw new TypeError("invalid rich report"); }
function richObject(v: unknown, keys: string): RichObject {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return badRich();
  const o = v as RichObject, expected = keys.split(" ");
  if (Object.keys(o).length !== expected.length || expected.some(k => !Object.hasOwn(o, k))) return badRich();
  return o;
}
function richText(v: unknown, max = 8192): string { if (typeof v !== "string" || richUtf8Bytes(v) > max || v.includes("\0")) return badRich(); return v; }
function richEnum(v: unknown, options: string): string { const s = richText(v, 64); if (!options.split(" ").includes(s)) return badRich(); return s; }
function richArray(v: unknown, max = 128): unknown[] { if (!Array.isArray(v) || v.length > max) return badRich(); return v; }
function richStrings(v: unknown): void { for (const s of richArray(v)) richText(s); }
function richNullable(v: unknown, check: (x: unknown) => unknown): void { if (v !== null) check(v); }
function richUint(v: unknown): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 0xffff_ffff) return badRich(); return v; }
function richBool(v: unknown): void { if (typeof v !== "boolean") badRich(); }
function richHex(v: unknown): string { const s = richText(v, 32); if (!/^0x[0-9a-f]{1,16}$/.test(s)) return badRich(); return s; }
function richPdb(v: unknown): RichObject { const o = richObject(v, "guid age"); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(richText(o.guid, 36))) badRich(); richUint(o.age); return o; }
const RICH_CAPTURE_STATUS = "present partial absent unavailable failed timedOut truncated";
const RICH_SYMBOL_QUALITY = "matched exportsOnly missing mismatched unverified";

/** Validate all mandatory groups and every nested evidence reference. */
export function validateRichDocument(value: unknown): RichObject {
  const r = richObject(value, "schemaVersion reportId identity outcome summary provenance exception context stack symbols rootCause evidence completeness");
  if (r.schemaVersion !== 2 || !/^r2_[0-9a-f]{64}$/.test(richText(r.reportId, 67))) badRich();
  const identity = richObject(r.identity, "dumpId inputSha256 kind analyzerName analyzerVersion");
  for (const key of ["dumpId", "kind", "analyzerName", "analyzerVersion"]) if (richText(identity[key], 256).length === 0) badRich();
  if (!/^[0-9a-f]{64}$/.test(richText(identity.inputSha256, 64))) badRich();
  richEnum(r.outcome, "completed failed"); richText(r.summary, 8000);
  const p = richObject(r.provenance, "provider debuggerVersion architecture pointerWidth processId model analysisRevision");
  richText(p.provider); richText(p.analysisRevision);
  for (const k of ["debuggerVersion", "architecture", "processId", "model"]) richNullable(p[k], richText);
  richNullable(p.pointerWidth, x => { if (x !== 32 && x !== 64) badRich(); });
  const ids = new Set<string>();
  for (const raw of richArray(r.evidence, MAX_RICH_EVIDENCE)) {
    const e = richObject(raw, "id command status text truncated error"), id = richText(e.id, 80);
    if (!id || ids.has(id)) badRich(); ids.add(id);
    richText(e.command); richEnum(e.status, RICH_CAPTURE_STATUS); richText(e.text, 8192); richBool(e.truncated); richNullable(e.error, richText);
  }
  const refs = (v: unknown): void => { for (const id of richArray(v, MAX_RICH_EVIDENCE)) if (typeof id !== "string" || !ids.has(id)) badRich(); };
  const ex = richObject(r.exception, "status code flags address recordPointer parameterCount parameters access evidenceRefs");
  richEnum(ex.status, RICH_CAPTURE_STATUS);
  for (const k of ["code", "flags", "address", "recordPointer"]) richNullable(ex[k], richHex);
  richNullable(ex.parameterCount, richUint); for (const x of richArray(ex.parameters, 15)) richHex(x); refs(ex.evidenceRefs);
  if (ex.status === "present" && ex.parameterCount !== null && ex.parameterCount !== (ex.parameters as unknown[]).length) badRich();
  richNullable(ex.access, raw => { const a = richObject(raw, "operation address underlyingStatus"); richEnum(a.operation, "read write execute unknown"); richHex(a.address); richNullable(a.underlyingStatus, richHex); });
  const context = richObject(r.context, "source threadId registers faultInstruction evidenceRefs");
  richEnum(context.source, "exception initial otherThread unavailable"); richNullable(context.threadId, richHex); refs(context.evidenceRefs);
  if (context.registers === null || typeof context.registers !== "object" || Array.isArray(context.registers) || Object.keys(context.registers).length > 64) badRich();
  for (const [name, v] of Object.entries(context.registers as RichObject)) { if (!/^[a-zA-Z][a-zA-Z0-9]{0,15}$/.test(name)) badRich(); richHex(v); }
  richNullable(context.faultInstruction, raw => {
    const i = richObject(raw, "address bytes disassembly effectiveAddress evidenceRefs"); richHex(i.address); richNullable(i.bytes, x => { if (!/^(?:[0-9a-fA-F]{2}){1,15}$/.test(richText(x, 30))) badRich(); }); richText(i.disassembly); richNullable(i.effectiveAddress, richHex); refs(i.evidenceRefs);
  });
  const stack = richObject(r.stack, "threadId status frames limitations");
  richNullable(stack.threadId, richHex); richEnum(stack.status, RICH_CAPTURE_STATUS); richStrings(stack.limitations);
  const frameIndexes = new Set<number>();
  for (const raw of richArray(stack.frames, MAX_RICH_FRAMES)) {
    const f = richObject(raw, "index instructionPointer stackPointer framePointer returnAddress module moduleRva function displacement sourceFile sourceLine resolution unwind evidenceRefs");
    const index = richUint(f.index); if (frameIndexes.has(index)) badRich(); frameIndexes.add(index);
    for (const k of ["instructionPointer", "stackPointer", "framePointer", "returnAddress", "moduleRva", "displacement"]) richNullable(f[k], richHex);
    for (const k of ["module", "function", "sourceFile"]) richNullable(f[k], richText);
    richNullable(f.sourceLine, richUint); richEnum(f.resolution, RICH_SYMBOL_QUALITY); richEnum(f.unwind, "reported unreliable unknown"); refs(f.evidenceRefs);
  }
  const symbols = richObject(r.symbols, "modules limitations"); richStrings(symbols.limitations);
  const matchedModules = new Set<string>();
  for (const raw of richArray(symbols.modules, MAX_RICH_MODULES)) {
    const m = richObject(raw, "module imageBase imageSize timestamp expectedPdb loadedPdb pdbPath quality evidenceRefs"); richText(m.module);
    for (const k of ["imageBase", "imageSize", "timestamp"]) richNullable(m[k], richHex);
    richNullable(m.expectedPdb, richPdb); richNullable(m.loadedPdb, richPdb); richNullable(m.pdbPath, richText); richEnum(m.quality, RICH_SYMBOL_QUALITY); refs(m.evidenceRefs);
    if (m.quality === "matched") {
      if (m.expectedPdb === null || m.loadedPdb === null) badRich();
      const expected = m.expectedPdb as RichObject, loaded = m.loadedPdb as RichObject;
      if (expected.guid !== loaded.guid || expected.age !== loaded.age || (m.evidenceRefs as unknown[]).length === 0) badRich();
      matchedModules.add(m.module as string);
    }
  }
  for (const raw of stack.frames as RichObject[]) if (raw.resolution === "matched" && (!matchedModules.has(raw.module as string) || (raw.evidenceRefs as unknown[]).length === 0)) badRich();
  const root = richObject(r.rootCause, "status mechanism conclusion evidenceRefs hypotheses missingEvidence nextChecks ruleId");
  // No underlying-cause confirmation rule ships in this release.
  richEnum(root.status, "hypothesis unknown"); richText(root.conclusion); refs(root.evidenceRefs); richStrings(root.missingEvidence); richStrings(root.nextChecks); if (root.ruleId !== null) badRich();
  const mechanism = richObject(root.mechanism, "status description evidenceRefs");
  richEnum(mechanism.status, "confirmed hypothesis unknown"); richText(mechanism.description); refs(mechanism.evidenceRefs);
  for (const raw of richArray(root.hypotheses, 16)) {
    const h = richObject(raw, "explanation evidenceRefs missingEvidence nextChecks"); richText(h.explanation); refs(h.evidenceRefs); richStrings(h.missingEvidence); richStrings(h.nextChecks);
    if ((h.evidenceRefs as unknown[]).length === 0) badRich();
  }
  if (root.status === "hypothesis" && ((root.evidenceRefs as unknown[]).length === 0 || (root.missingEvidence as unknown[]).length === 0)) badRich();
  if (mechanism.status === "confirmed") {
    if (ex.code !== "0xc0000005" || ex.access === null || context.source !== "exception") badRich();
    const access = ex.access as RichObject, instruction = context.faultInstruction as RichObject | null;
    const address = (v: unknown): bigint => BigInt(`0x${richHex(v).replace(/^0x/, "")}`);
    if (access.operation !== "read" || instruction === null || ex.address === null || address(instruction.address) !== address(ex.address)) badRich();
    const code = (instruction.disassembly as string).toLowerCase(), whitespace = code.search(/\s/);
    if (whitespace < 0 || code.slice(0, whitespace) !== "mov") badRich();
    const operands = code.slice(whitespace + 1), comma = operands.indexOf(",");
    if (comma < 0 || operands.slice(0, comma).includes("[")) badRich();
    const source = operands.slice(comma + 1), start = source.indexOf("["), end = source.indexOf("]", start + 1);
    if (start < 0 || end < 0) badRich();
    const register = source.slice(start + 1, end).trim();
    if (!/^[a-z0-9]+$/.test(register)) badRich();
    const value = (context.registers as RichObject)[register];
    if (value === undefined || address(value) !== address(access.address)) badRich();
    if ((ex.evidenceRefs as unknown[]).length === 0 || (instruction.evidenceRefs as unknown[]).length === 0 || (context.evidenceRefs as unknown[]).length === 0) badRich();
    const expectedRefs = [...new Set([...(ex.evidenceRefs as string[]), ...(context.evidenceRefs as string[]), ...(instruction.evidenceRefs as string[])])].sort();
    if (JSON.stringify(mechanism.evidenceRefs) !== JSON.stringify(expectedRefs)) badRich();
    const expected = `The saved exception instruction reads through ${register} at ${value as string}, matching the access-violation target ${access.address as string}. This establishes the immediate faulting read; the origin of the pointer is not established.`;
    if (mechanism.description !== expected) badRich();
  }
  const completeness = richObject(r.completeness, "omissions truncated"); richStrings(completeness.omissions); richBool(completeness.truncated);
  return r;
}

export interface RichAnalysisDetail { readonly reportJson: string; readonly reportDigest: string }
export interface RichAnalysisBinding { readonly dumpId: string; readonly inputSha256: string; readonly kind: string; readonly analyzerName: string; readonly analyzerVersion: string; readonly outcome: string; readonly summary: string; readonly facts: Readonly<Record<string, unknown>> | null }
export function assertRichAnalysis(detail: RichAnalysisDetail, binding: RichAnalysisBinding): RichAnalysisDetail {
  try {
    if (typeof detail.reportJson !== "string" || richUtf8Bytes(detail.reportJson) > MAX_RICH_REPORT_BYTES || !/^[0-9a-f]{64}$/.test(detail.reportDigest) || createHash("sha256").update(detail.reportJson, "utf8").digest("hex") !== detail.reportDigest) badRich();
    const report = validateRichDocument(JSON.parse(detail.reportJson) as unknown), i = report.identity as RichObject;
    // Rust canonical_json uses recursively sorted object keys. Requiring the
    // exact canonical text also rejects duplicate keys at the engine boundary.
    const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as RichObject)[k])])) : v;
    if (JSON.stringify(stable(report)) !== detail.reportJson) badRich();
    for (const k of ["dumpId", "inputSha256", "kind", "analyzerName", "analyzerVersion"] as const) if (i[k] !== binding[k]) badRich();
    const hash = createHash("sha256");
    for (const k of ["dumpId", "inputSha256", "kind", "analyzerName", "analyzerVersion"] as const) { const bytes = Buffer.from(binding[k], "utf8"), size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(bytes.length)); hash.update(size).update(bytes); }
    if (report.reportId !== `r2_${hash.digest("hex")}` || report.outcome !== binding.outcome || report.summary !== binding.summary) badRich();
    const facts = binding.facts, exception = report.exception as RichObject, stack = report.stack as RichObject, cause = report.rootCause as RichObject;
    if (facts === null || facts.schemaVersion !== 2 || facts.reportId !== report.reportId || facts.reportDigest !== detail.reportDigest || facts.exceptionCode !== exception.code || facts.frameCount !== (stack.frames as unknown[]).length || facts.causeStatus !== cause.status) badRich();
    return detail;
  } catch { throw new DumpLedgerError("invalid_input", "canonical report or digest binding is invalid"); }
}
