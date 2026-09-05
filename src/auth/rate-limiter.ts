export interface FixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  readonly now?: () => number;
}

interface WindowEntry {
  readonly startedAt: number;
  readonly attempts: number;
  readonly lastSeenAt: number;
}

/** Small, process-local abuse guard. A reverse proxy remains the outer DoS boundary. */
export class FixedWindowRateLimiter {
  readonly #entries = new Map<string, WindowEntry>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError("rate limit must be positive");
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) throw new RangeError("rate window must be positive");
    if (!Number.isInteger(options.maxKeys) || options.maxKeys < 1) throw new RangeError("maxKeys must be positive");
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys;
    this.#now = options.now ?? Date.now;
  }

  get size(): number { return this.#entries.size; }

  take(key: string): boolean {
    const now = this.#now();
    this.#prune(now);
    const current = this.#entries.get(key);
    if (current !== undefined && now - current.startedAt < this.#windowMs) {
      this.#entries.set(key, { ...current, attempts: current.attempts + 1, lastSeenAt: now });
      return current.attempts < this.#limit;
    }
    if (current === undefined && this.#entries.size >= this.#maxKeys) this.#evictOldest();
    this.#entries.set(key, { startedAt: now, attempts: 1, lastSeenAt: now });
    return true;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.startedAt >= this.#windowMs) this.#entries.delete(key);
    }
  }

  #evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#entries) {
      if (entry.lastSeenAt < oldestSeen) {
        oldestSeen = entry.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.#entries.delete(oldestKey);
  }
}
