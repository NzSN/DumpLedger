import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "dump_ledger_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

export interface OperatorSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

interface StoredSession {
  readonly csrfDigest: Buffer;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export interface LoginResult {
  readonly setCookie: string;
  readonly csrfToken: string;
}

export interface OperatorSessionsOptions {
  readonly passwordHash: string;
  readonly secureCookies: boolean;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
  readonly ttlMs?: number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export async function hashOperatorPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error("operator password must contain at least 8 characters");
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 32) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyOperatorPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, digestText, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || saltText === undefined || digestText === undefined || extra !== undefined) {
    return false;
  }
  try {
    const expected = Buffer.from(digestText, "base64url");
    const actual = await scrypt(password, Buffer.from(saltText, "base64url"), expected.byteLength) as Buffer;
    return equalDigest(actual, expected);
  } catch {
    return false;
  }
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return /^[A-Za-z0-9_-]{16,}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export class OperatorSessions {
  readonly #options: Required<Pick<OperatorSessionsOptions, "now" | "random" | "ttlMs">> & OperatorSessionsOptions;
  readonly #sessions = new Map<string, StoredSession>();

  constructor(options: OperatorSessionsOptions) {
    if (!/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(options.passwordHash)) {
      throw new Error("operator password hash is not a supported scrypt value");
    }
    this.#options = {
      ...options,
      now: options.now ?? Date.now,
      random: options.random ?? randomBytes,
      ttlMs: options.ttlMs ?? SESSION_TTL_MS,
    };
  }

  async login(password: string): Promise<LoginResult | undefined> {
    if (!await verifyOperatorPassword(password, this.#options.passwordHash)) return undefined;
    const token = this.#options.random(32).toString("base64url");
    const csrfToken = this.#options.random(32).toString("base64url");
    const expiresAt = this.#options.now() + this.#options.ttlMs;
    this.#sessions.set(digest(token).toString("hex"), {
      csrfDigest: digest(csrfToken),
      csrfToken,
      expiresAt,
    });
    const secure = this.#options.secureCookies ? "; Secure" : "";
    return {
      csrfToken,
      setCookie: `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(this.#options.ttlMs / 1_000)}; HttpOnly; SameSite=Strict${secure}`,
    };
  }

  authenticate(cookieHeader: string | undefined): OperatorSession | undefined {
    const token = cookieValue(cookieHeader, COOKIE_NAME);
    if (token === undefined) return undefined;
    const id = digest(token).toString("hex");
    const stored = this.#sessions.get(id);
    if (stored === undefined) return undefined;
    if (stored.expiresAt <= this.#options.now()) {
      this.#sessions.delete(id);
      return undefined;
    }
    return { id, csrfToken: stored.csrfToken, expiresAt: stored.expiresAt };
  }

  verifyCsrf(session: OperatorSession, presented: string | undefined): boolean {
    if (presented === undefined) return false;
    const stored = this.#sessions.get(session.id);
    return stored !== undefined && equalDigest(stored.csrfDigest, digest(presented));
  }

  logout(session: OperatorSession): string {
    this.#sessions.delete(session.id);
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${this.#options.secureCookies ? "; Secure" : ""}`;
  }
}
