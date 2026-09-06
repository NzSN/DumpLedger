import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClientGenTraces, specFromFiles } from "mirrorecma";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface TraceCase {
  readonly destination: string;
  readonly witnessModule: string;
  readonly lengthBound: number;
  readonly nextPredicate?: string;
  readonly terminalDescription: string;
  readonly terminalMatches: (state: JsonObject) => boolean;
}

interface CliOptions {
  readonly mirrorBin: string;
  readonly replace: boolean;
}

function locateRepositoryRoot(moduleDirectory: string): string {
  const candidates = [
    resolve(moduleDirectory, ".."),
    resolve(moduleDirectory, "..", ".."),
  ];
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, "specs", "DumpLedger.tla")));
  if (found === undefined) {
    throw new Error(`cannot locate repository root from ${moduleDirectory}`);
  }
  return found;
}

const repositoryRoot = locateRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
const specsRoot = join(repositoryRoot, "specs");
const fixturesRoot = join(repositoryRoot, "test", "fixtures", "mbt", "traces");

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEncodedInt(value: Json | undefined, expected: string): boolean {
  return isObject(value) &&
    Object.keys(value).length === 1 &&
    value["#bigint"] === expected;
}

function sequenceSlot(state: JsonObject, name: string, slot: number): Json | undefined {
  const sequence = state[name];
  return Array.isArray(sequence) ? sequence[slot - 1] : undefined;
}

function parametersMatch(
  state: JsonObject,
  expected: {
    readonly case?: string;
    readonly token: string;
    readonly dump: string;
    readonly kind: string;
  },
): boolean {
  const parameters = state["parameters"];
  return isObject(parameters) &&
    (expected.case === undefined || isEncodedInt(parameters["case"], expected.case)) &&
    isEncodedInt(parameters["token"], expected.token) &&
    isEncodedInt(parameters["dump"], expected.dump) &&
    parameters["kind"] === expected.kind;
}

function deletedDump(
  coverage: "partial" | "full-memory-declared" | "unknown",
): (state: JsonObject) => boolean {
  return (state) =>
    state["action_taken"] === "FinishPurge" &&
    parametersMatch(state, { token: "0", dump: "1", kind: "unclassified" }) &&
    sequenceSlot(state, "dumpPhase", 1) === "deleted" &&
    sequenceSlot(state, "blobState", 1) === "none" &&
    isEncodedInt(sequenceSlot(state, "tokenDump", 1), "1") &&
    sequenceSlot(state, "validation", 1) === "valid" &&
    sequenceSlot(state, "coverage", 1) === coverage;
}

const traceCases: readonly TraceCase[] = [
  {
    destination: "01-accepted-partial-delete.itf.json",
    witnessModule: "AcceptedPartial",
    lengthBound: 8,
    terminalDescription: "FinishPurge with dump slot 1 deleted after partial acceptance",
    terminalMatches: deletedDump("partial"),
  },
  {
    destination: "02-accepted-full-declared-delete.itf.json",
    witnessModule: "AcceptedFullDeclared",
    lengthBound: 8,
    terminalDescription: "FinishPurge with dump slot 1 deleted after full-memory-declared acceptance",
    terminalMatches: deletedDump("full-memory-declared"),
  },
  {
    destination: "03-accepted-unknown-delete.itf.json",
    witnessModule: "AcceptedUnknown",
    lengthBound: 8,
    terminalDescription: "FinishPurge with dump slot 1 deleted after unknown acceptance",
    terminalMatches: deletedDump("unknown"),
  },
  {
    destination: "04-invalid-rejected-delete.itf.json",
    witnessModule: "InvalidRejected",
    lengthBound: 8,
    terminalDescription: "FinishPurge with structurally invalid dump slot 1 deleted",
    terminalMatches: (state) =>
      state["action_taken"] === "FinishPurge" &&
      parametersMatch(state, { token: "0", dump: "1", kind: "unclassified" }) &&
      sequenceSlot(state, "dumpPhase", 1) === "deleted" &&
      sequenceSlot(state, "blobState", 1) === "none" &&
      isEncodedInt(sequenceSlot(state, "tokenDump", 2), "1") &&
      sequenceSlot(state, "validation", 1) === "invalid",
  },
  {
    destination: "05-transfer-failed-delete.itf.json",
    witnessModule: "TransferFailed",
    lengthBound: 5,
    terminalDescription: "FinishPurge with transfer-failed dump slot 1 deleted",
    terminalMatches: (state) =>
      state["action_taken"] === "FinishPurge" &&
      parametersMatch(state, { token: "0", dump: "1", kind: "unclassified" }) &&
      sequenceSlot(state, "dumpPhase", 1) === "deleted" &&
      sequenceSlot(state, "blobState", 1) === "none" &&
      isEncodedInt(sequenceSlot(state, "tokenDump", 1), "1") &&
      sequenceSlot(state, "validation", 1) === "transfer-failed",
  },
  {
    destination: "06-token-revoked-expired.itf.json",
    witnessModule: "TokensRevokedExpired",
    lengthBound: 4,
    nextPredicate: "WitnessNext",
    terminalDescription: "RevokeToken with token slots 1 revoked and 2 expired",
    terminalMatches: (state) =>
      state["action_taken"] === "RevokeToken" &&
      parametersMatch(state, { token: "1", dump: "0", kind: "unclassified" }) &&
      sequenceSlot(state, "tokenState", 1) === "revoked" &&
      sequenceSlot(state, "tokenState", 2) === "expired",
  },
  {
    destination: "07-case-closed-grants-revoked.itf.json",
    witnessModule: "CaseWorkflow",
    lengthBound: 6,
    nextPredicate: "WitnessNext",
    terminalDescription: "CloseCase with case slot 1 closed and its issued grant revoked",
    terminalMatches: (state) =>
      state["action_taken"] === "CloseCase" &&
      parametersMatch(state, { case: "1", token: "0", dump: "0", kind: "unclassified" }) &&
      sequenceSlot(state, "caseStatus", 1) === "closed" &&
      sequenceSlot(state, "caseStatus", 2) === "new" &&
      sequenceSlot(state, "tokenState", 1) === "revoked" &&
      sequenceSlot(state, "tokenState", 2) === "unused",
  },
];

function usage(): string {
  return [
    "usage: node dist/tools/generate-mbt-traces.js [--replace] [--mirror-bin FILE]",
    "",
    "Without --replace, generate into a temporary directory and compare each",
    "selected trace semantically with its reviewed fixture. No fixture is written.",
    "MIRROR_BIN or MIRRORS_ROOT may supply the Mirrors executable path.",
  ].join("\n");
}

function parseArguments(argv: readonly string[]): CliOptions | "help" {
  let mirrorBin: string | undefined;
  let replace = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--replace") {
      replace = true;
      continue;
    }
    if (argument === "--mirror-bin") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--mirror-bin requires a path");
      }
      mirrorBin = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--mirror-bin=")) {
      mirrorBin = argument.slice("--mirror-bin=".length);
      if (mirrorBin.length === 0) throw new Error("--mirror-bin requires a path");
      continue;
    }
    throw new Error(`unknown argument: ${argument ?? "<missing>"}`);
  }

  const configuredMirror = mirrorBin ?? process.env["MIRROR_BIN"] ??
    (process.env["MIRRORS_ROOT"] === undefined
      ? undefined
      : join(process.env["MIRRORS_ROOT"], ".lake", "build", "bin", "mirror"));
  if (configuredMirror === undefined) {
    throw new Error("set MIRROR_BIN, set MIRRORS_ROOT, or pass --mirror-bin FILE");
  }
  return { mirrorBin: resolve(configuredMirror), replace };
}

function normalizeJson(value: unknown, path = "$" ): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: non-finite JSON number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJson(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: JsonObject = Object.create(null) as JsonObject;
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeJson(record[key], `${path}.${key}`);
    }
    return normalized;
  }
  throw new Error(`${path}: value is not JSON`);
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalizeJson(value))}\n`;
}

function semanticTrace(value: unknown): Json {
  const trace = normalizeJson(value);
  if (isObject(trace)) {
    const metadata = trace["#meta"];
    if (isObject(metadata)) delete metadata["description"];
  }
  return trace;
}

function canonicalTrace(value: unknown): string {
  return canonicalJson(semanticTrace(value));
}

function parseJson(text: string, source: string): Json {
  try {
    return normalizeJson(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(`${source}: invalid JSON`, { cause: error });
  }
}

function statesOf(trace: Json, source: string): JsonObject[] {
  if (!isObject(trace) || !Array.isArray(trace["states"]) || trace["states"].length === 0) {
    throw new Error(`${source}: ITF trace has no states`);
  }
  return trace["states"].map((state, index) => {
    if (!isObject(state)) throw new Error(`${source}: states[${index}] is not an object`);
    return state;
  });
}

function terminalState(trace: Json, source: string): JsonObject {
  const states = statesOf(trace, source);
  const terminal = states[states.length - 1];
  if (terminal === undefined) throw new Error(`${source}: ITF trace has no terminal state`);
  return terminal;
}

async function generatedTraces(
  inline: readonly unknown[],
  paths: readonly string[],
): Promise<readonly Json[]> {
  if (paths.length > 0) {
    if (inline.length > 0 && paths.length !== inline.length) {
      throw new Error(`MirrorECMA returned ${paths.length} paths but ${inline.length} inline traces`);
    }
    // The local Apalache files are the evidence accepted by model_interface_gen.
    // Inline protocol decoding intentionally normalizes some metadata integers,
    // so use the exact returned paths without scanning or ordering the directory.
    return Promise.all(paths.map(async (path) => parseJson(await readFile(path, "utf8"), path)));
  }
  if (inline.length === 0) throw new Error("MirrorECMA returned no generated traces");
  return inline.map((trace, index) => normalizeJson(trace, `inline trace ${index}`));
}

function selectUniqueTrace(testCase: TraceCase, traces: readonly Json[]): Json {
  const matches = traces.filter((trace, index) =>
    testCase.terminalMatches(terminalState(trace, `generated trace ${index}`)));
  if (matches.length === 0) {
    throw new Error(`${testCase.destination}: no trace reached ${testCase.terminalDescription}`);
  }

  const unique = new Map<string, Json>();
  for (const match of matches) unique.set(canonicalTrace(match), match);
  if (unique.size !== 1) {
    throw new Error(
      `${testCase.destination}: ${unique.size} semantically distinct traces reached ` +
      `${testCase.terminalDescription}; selection is ambiguous`,
    );
  }
  if (matches.length > 1) {
    process.stdout.write(
      `${testCase.destination}: collapsed ${matches.length} byte-identical/semantic duplicate witnesses\n`,
    );
  }
  const selected = unique.values().next().value as Json | undefined;
  if (selected === undefined) throw new Error(`${testCase.destination}: internal selection failure`);
  return selected;
}

function digest(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

function firstDifference(expected: Json, actual: Json, path = "$" ): string | undefined {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${path}: expected ${JSON.stringify(expected)}, generated ${JSON.stringify(actual)}`;
    }
    if (expected.length !== actual.length) {
      return `${path}: expected length ${expected.length}, generated length ${actual.length}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index]!, actual[index]!, `${path}[${index}]`);
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  if (isObject(expected) || isObject(actual)) {
    if (!isObject(expected) || !isObject(actual)) {
      return `${path}: expected ${JSON.stringify(expected)}, generated ${JSON.stringify(actual)}`;
    }
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
      return `${path}: expected keys [${expectedKeys.join(",")}], generated keys [${actualKeys.join(",")}]`;
    }
    for (const key of expectedKeys) {
      const difference = firstDifference(expected[key]!, actual[key]!, `${path}.${key}`);
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  return expected === actual
    ? undefined
    : `${path}: expected ${JSON.stringify(expected)}, generated ${JSON.stringify(actual)}`;
}

async function compareOrReplace(
  testCase: TraceCase,
  selected: Json,
  replace: boolean,
): Promise<boolean> {
  const fixture = join(fixturesRoot, testCase.destination);
  const generatedSemantic = semanticTrace(selected);
  const generatedCanonical = canonicalJson(generatedSemantic);
  let reviewed: Json | undefined;
  try {
    reviewed = parseJson(await readFile(fixture, "utf8"), fixture);
  } catch (error) {
    if (!replace) {
      process.stderr.write(`${testCase.destination}: reviewed fixture is missing or invalid: ${String(error)}\n`);
      return false;
    }
  }

  if (reviewed !== undefined) {
    const reviewedSemantic = semanticTrace(reviewed);
    const reviewedCanonical = canonicalJson(reviewedSemantic);
    if (reviewedCanonical === generatedCanonical) {
      process.stdout.write(`${testCase.destination}: current (${digest(generatedCanonical)})\n`);
      return true;
    }
    const difference = firstDifference(reviewedSemantic, generatedSemantic) ?? "canonical bytes differ";
    process.stderr.write(
      `${testCase.destination}: differs\n` +
      `  reviewed sha256 ${digest(reviewedCanonical)}\n` +
      `  generated sha256 ${digest(generatedCanonical)}\n` +
      `  first difference: ${difference}\n`,
    );
  }

  if (!replace) return false;
  await mkdir(fixturesRoot, { recursive: true });
  await writeFile(fixture, generatedCanonical, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${testCase.destination}: replaced explicitly (${digest(generatedCanonical)})\n`);
  return true;
}

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const generationRoot = await mkdtemp(join(tmpdir(), "dump-ledger-mbt-"));
  let allCurrent = true;
  try {
    for (const testCase of traceCases) {
      const witnessPath = join(specsRoot, "mbt", `${testCase.witnessModule}.tla`);
      const generationDirectory = join(generationRoot, testCase.witnessModule);
      await mkdir(generationDirectory, { recursive: true });
      const spec = await specFromFiles(witnessPath, [specsRoot]);
      const result = await runClientGenTraces(
        options.mirrorBin,
        {
          specPath: witnessPath,
          initPredicate: "Init",
          nextPredicate: testCase.nextPredicate ?? "Next",
          invariant: "WitnessNotReached",
          lengthBound: testCase.lengthBound,
          paramVars: "parameters",
        },
        generationDirectory,
        { numTraces: 1 },
        { spec },
      );
      const traces = await generatedTraces(result.itfTraces, result.itfTracePaths);
      const selected = selectUniqueTrace(testCase, traces);
      allCurrent = await compareOrReplace(testCase, selected, options.replace) && allCurrent;
    }
  } finally {
    await rm(generationRoot, { recursive: true, force: true });
  }

  if (!allCurrent) {
    throw new Error("generated traces differ; reviewed fixtures were not modified (pass --replace to replace explicitly)");
  }
}

run().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${detail}\n`);
  process.exitCode = 1;
});
