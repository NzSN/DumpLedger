/**
 * Framework-free runtime validation toolkit shared by the DumpLedger browser
 * and Fastify process.
 *
 * Everything here is pure ECMAScript: no Node, Fastify, React, DOM, filesystem,
 * SQLite, or engine modules are imported, and no runtime global beyond the
 * ECMAScript standard library (JSON, Date, BigInt) is required.
 *
 * Decoders validate untrusted JSON-shaped values and throw {@link DecodeError}
 * on the first violation. They reject:
 *   - missing required fields,
 *   - extra (unknown) fields,
 *   - duplicate object keys (detected before JSON.parse),
 *   - malformed values (bad enums, canonical forms, patterns),
 *   - oversized values (strings, numbers, arrays, whole payloads),
 *   - wrong-type values.
 */

export class DecodeError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "DecodeError";
  }
}

/** A runtime decoder from an untrusted JSON value to a trusted typed value. */
export type Decoder<T> = (value: unknown, path: string) => T;

/** Highest accepted length for one decoded string field. */
export const MAX_TEXT_LENGTH = 16_384;

/** Highest accepted length for one opaque identifier. */
export const MAX_IDENTIFIER_LENGTH = 128;

/** Highest accepted number of characters in a single JSON request/response. */
export const MAX_JSON_TEXT_LENGTH = 1_048_576;

/** Highest accepted number of significant digits in a canonical decimal. */
export const MAX_CANONICAL_DECIMAL_DIGITS = 40;

/** Highest accepted nesting depth for inbound JSON. */
export const MAX_JSON_DEPTH = 100;

export function fail(path: string, message: string): never {
  throw new DecodeError(path, message);
}

export function childPath(path: string, key: string | number): string {
  return typeof key === "number" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text decoder with length bounds, control-character rejection, and an optional pattern. */
export function text(options: {
  readonly min?: number;
  readonly max: number;
  readonly label: string;
  readonly pattern?: RegExp;
}): Decoder<string> {
  const min = options.min ?? 1;
  return (value, path) => {
    if (typeof value !== "string") fail(path, `${options.label} must be a string`);
    if (value.length < min) fail(path, `${options.label} must not be empty`);
    if (value.length > options.max) fail(path, `${options.label} exceeds ${options.max} characters`);
    if (/[\u0000-\u001f\u007f]/.test(value)) fail(path, `${options.label} contains control characters`);
    if (options.pattern !== undefined && !options.pattern.test(value)) {
      fail(path, `${options.label} is malformed`);
    }
    return value;
  };
}

export function booleanField(): Decoder<boolean> {
  return (value, path) => {
    if (typeof value !== "boolean") fail(path, "must be a boolean");
    return value;
  };
}

/** A JSON number that is finite. */
export function numberField(options: { readonly label: string }): Decoder<number> {
  return (value, path) => {
    if (typeof value !== "number") fail(path, `${options.label} must be a number`);
    if (!Number.isFinite(value)) fail(path, `${options.label} must be finite`);
    return value;
  };
}

/** A safe integer within an optional inclusive range. */
export function integerField(options: {
  readonly min?: number;
  readonly max?: number;
  readonly label: string;
}): Decoder<number> {
  return (value, path) => {
    const decoded = numberField(options)(value, path);
    if (!Number.isSafeInteger(decoded)) fail(path, `${options.label} must be a safe integer`);
    if (options.min !== undefined && decoded < options.min) {
      fail(path, `${options.label} is below the minimum of ${options.min}`);
    }
    if (options.max !== undefined && decoded > options.max) {
      fail(path, `${options.label} exceeds the maximum of ${options.max}`);
    }
    return decoded;
  };
}

/** A non-negative safe integer counter. */
export function counterField(label: string): Decoder<number> {
  return integerField({ min: 0, label });
}

/** Exactly one member of a closed string vocabulary. */
export function oneOf<T extends string>(values: readonly T[], label: string): Decoder<T> {
  const allowed = values as readonly string[];
  return (value, path) => {
    if (typeof value !== "string" || !allowed.includes(value)) {
      fail(path, `${label} is invalid`);
    }
    return value as T;
  };
}

export function arrayOf<T>(
  item: Decoder<T>,
  options: { readonly label: string; readonly maxLength?: number },
): Decoder<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, `${options.label} must be an array`);
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      fail(path, `${options.label} exceeds ${options.maxLength} items`);
    }
    return value.map((entry, index) => item(entry, childPath(path, index)));
  };
}

export function nullableField<T>(inner: Decoder<T>): Decoder<T | null> {
  return (value, path) => (value === null ? null : inner(value, path));
}

/** Marks a field as optional (absent keys decode to `undefined`). */
export function optional<T>(decoder: Decoder<T>): { readonly optional: true; readonly decode: Decoder<T> } {
  return { optional: true, decode: decoder };
}

/** Marks a field as required (the default). */
export function field<T>(decoder: Decoder<T>): { readonly optional?: false; readonly decode: Decoder<T> } {
  return { decode: decoder };
}

export type FieldSpec = { readonly optional?: boolean; readonly decode: Decoder<unknown> };
export type Shape = Readonly<Record<string, FieldSpec>>;

type FieldType<S extends FieldSpec> = S extends { readonly decode: Decoder<infer T> } ? T : never;

export type ObjectResult<S extends Shape> = {
  -readonly [K in keyof S]: S[K] extends { readonly optional: true }
    ? FieldType<S[K]> | undefined
    : FieldType<S[K]>;
};

/**
 * Strict object decoder: unknown keys are rejected, every required key must be
 * present, and every present value is decoded. Optional absent keys are left
 * out of the returned object.
 */
export function object<S extends Shape>(shape: S, label: string): Decoder<ObjectResult<S>> {
  return (value, path) => {
    if (!isRecord(value)) fail(path, `${label} must be a JSON object`);
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const spec = shape[key];
      if (spec === undefined) fail(childPath(path, key), "unexpected field");
      if (record[key] === undefined) {
        if (spec.optional !== true) fail(childPath(path, key), "field must not be undefined");
        continue;
      }
      output[key] = spec.decode(record[key], childPath(path, key));
    }
    for (const key of Object.keys(shape)) {
      const spec = shape[key];
      if (spec === undefined || spec.optional === true) continue;
      if (!(key in record)) fail(childPath(path, key), "missing required field");
    }
    return output as ObjectResult<S>;
  };
}

/** Opaque identifier: non-empty, bounded, no whitespace or control characters. */
export function identifierField(label: string): Decoder<string> {
  return text({ max: MAX_IDENTIFIER_LENGTH, label, pattern: /^\S+$/ });
}

const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function isCanonicalUtc(value: string): boolean {
  if (!TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  try {
    return new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * Canonical UTC timestamp: milliseconds precision, `Z` suffix, and a real
 * calendar date that round-trips through `Date.prototype.toISOString`.
 */
export function canonicalTimestamp(label: string): Decoder<string> {
  return (value, path) => {
    const decoded = text({ max: 40, label })(value, path);
    if (!isCanonicalUtc(decoded)) fail(path, `${label} is not a canonical UTC timestamp`);
    return decoded;
  };
}

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Canonical decimal string for bigint values crossing the wire: an unsigned
 * integer with no sign, leading zeros, fraction, or exponent.
 */
export function canonicalDecimal(options: { readonly label: string; readonly positive?: boolean }): Decoder<bigint> {
  const positive = options.positive === true;
  return (value, path) => {
    const decoded = text({ max: MAX_CANONICAL_DECIMAL_DIGITS, label: options.label })(value, path);
    if (!DECIMAL_PATTERN.test(decoded)) fail(path, `${options.label} must be a canonical decimal string`);
    if (positive && decoded === "0") fail(path, `${options.label} must be positive`);
    return BigInt(decoded);
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function sha256Hex(label: string): Decoder<string> {
  return text({ max: 64, label, pattern: SHA256_PATTERN });
}

/** Canonical form for a relative URL path beginning with exactly one slash. */
export function relativePath(options: { readonly max: number; readonly label: string }): Decoder<string> {
  return (value, path) => {
    const decoded = text({ max: options.max, label: options.label, pattern: /^\S*$/ })(value, path);
    if (!decoded.startsWith("/")) fail(path, `${options.label} must be a relative path`);
    if (decoded.startsWith("//")) fail(path, `${options.label} must not be protocol-relative`);
    if (decoded.includes("://")) fail(path, `${options.label} must not contain a scheme`);
    if (decoded.includes("\\")) fail(path, `${options.label} must use forward slashes`);
    return decoded;
  };
}

/**
 * Parses a JSON text and runs {@link decoder}. Duplicate object keys are
 * rejected before parsing because JSON's last-value-wins merge is ambiguous
 * for structured data. Malformed JSON reports a content-free message.
 */
export function decodeJsonText<T>(jsonText: string, decoder: Decoder<T>): T {
  if (typeof jsonText !== "string") throw new DecodeError("$", "JSON payload must be a string");
  if (jsonText.length > MAX_JSON_TEXT_LENGTH) throw new DecodeError("$", "JSON payload exceeds the size limit");
  const duplicate = findDuplicateKey(jsonText);
  if (duplicate !== undefined) throw new DecodeError(duplicate.path, "duplicate field");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new DecodeError("$", "JSON payload is malformed");
  }
  return decoder(parsed, "$");
}

/** Serializes a validated value to compact JSON text. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value);
}

interface DuplicateFound {
  readonly key: string;
  readonly path: string;
}

class DuplicateKey extends Error {
  constructor(readonly found: DuplicateFound) {
    super("duplicate JSON key");
    this.name = "DuplicateKey";
  }
}

/**
 * Scans JSON text for duplicate object keys at any depth. Returns `undefined`
 * when the text is not structurally parseable (JSON.parse reports the real
 * error afterwards) or when no duplicate exists.
 */
function findDuplicateKey(jsonText: string): DuplicateFound | undefined {
  const length = jsonText.length;
  let position = 0;
  const stack: string[] = [];

  const skipWhitespace = (): void => {
    while (position < length) {
      const char = jsonText[position] as string;
      if (char === " " || char === "\t" || char === "\n" || char === "\r") position += 1;
      else break;
    }
  };

  const readString = (): string | undefined => {
    if (jsonText[position] !== '"') return undefined;
    position += 1;
    let result = "";
    while (position < length) {
      const char = jsonText[position] as string;
      if (char === "\\") {
        const escaped = jsonText[position + 1];
        if (escaped === "u") {
          result += jsonText.slice(position, position + 6);
          position += 6;
        } else {
          result += escaped ?? "";
          position += 2;
        }
        continue;
      }
      if (char === '"') {
        position += 1;
        return result;
      }
      result += char;
      position += 1;
    }
    return undefined;
  };

  const skipValue = (): boolean => {
    if (position >= length) return false;
    const char = jsonText[position] as string;
    if (char === '"') return readString() !== undefined;
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    while (position < length && !",]}".includes(jsonText[position] as string) && !/\s/.test(jsonText[position] as string)) {
      position += 1;
    }
    return true;
  };

  const parseObject = (): boolean => {
    if (stack.length >= MAX_JSON_DEPTH) return false;
    if (jsonText[position] !== "{") return false;
    position += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (jsonText[position] === "}") {
      position += 1;
      return true;
    }
    for (;;) {
      skipWhitespace();
      const key = readString();
      if (key === undefined) return false;
      skipWhitespace();
      if (jsonText[position] !== ":") return false;
      position += 1;
      skipWhitespace();
      if (keys.has(key)) {
        throw new DuplicateKey({ key, path: childPath(stack.join(".") === "" ? "$" : stack.join("."), key) });
      }
      keys.add(key);
      stack.push(key);
      const valueOk = skipValue();
      stack.pop();
      if (!valueOk) return false;
      skipWhitespace();
      const char = jsonText[position];
      if (char === ",") {
        position += 1;
        continue;
      }
      if (char === "}") {
        position += 1;
        return true;
      }
      return false;
    }
  };

  const parseArray = (): boolean => {
    if (stack.length >= MAX_JSON_DEPTH) return false;
    if (jsonText[position] !== "[") return false;
    position += 1;
    skipWhitespace();
    if (jsonText[position] === "]") {
      position += 1;
      return true;
    }
    for (;;) {
      skipWhitespace();
      if (!skipValue()) return false;
      skipWhitespace();
      const char = jsonText[position];
      if (char === ",") {
        position += 1;
        continue;
      }
      if (char === "]") {
        position += 1;
        return true;
      }
      return false;
    }
  };

  try {
    skipWhitespace();
    const root = jsonText[position];
    if (root === "{") {
      const ok = parseObject();
      if (!ok) return undefined;
    } else if (root === "[") {
      const ok = parseArray();
      if (!ok) return undefined;
    } else {
      return undefined;
    }
    skipWhitespace();
    return undefined;
  } catch (error) {
    if (error instanceof DuplicateKey) return error.found;
    return undefined;
  }
}
