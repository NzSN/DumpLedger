import type { UploadPostProcessor } from "./intake-facade.js";

type TimerHandle = unknown;

export interface PostProcessingQueueOptions {
  readonly processor: UploadPostProcessor;
  readonly maxPending?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (handle: TimerHandle) => void;
}

interface PendingItem { attempts: number }

export class PostProcessingQueue {
  readonly #processor: UploadPostProcessor;
  readonly #maxPending: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => TimerHandle;
  readonly #cancel: (handle: TimerHandle) => void;
  readonly #pending = new Map<string, PendingItem>();
  #timer: TimerHandle | undefined;
  #closed = false;
  #exhausted = 0;
  #totalRetries = 0;

  constructor(options: PostProcessingQueueOptions) {
    this.#processor = options.processor;
    this.#maxPending = options.maxPending ?? 128;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 1) throw new RangeError("maxPending must be positive");
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) throw new RangeError("maxAttempts must be positive");
    if (!Number.isFinite(this.#retryDelayMs) || this.#retryDelayMs < 0) throw new RangeError("retryDelayMs must not be negative");
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  enqueue(dumpId: string): boolean {
    if (this.#closed) return false;
    if (this.#pending.has(dumpId)) return true;
    if (this.#pending.size >= this.#maxPending) return false;
    this.#pending.set(dumpId, { attempts: 0 });
    this.#ensureTimer();
    return true;
  }

  snapshot(): { readonly pending: number; readonly exhausted: number; readonly totalRetries: number } {
    return { pending: this.#pending.size, exhausted: this.#exhausted, totalRetries: this.#totalRetries };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) this.#cancel(this.#timer);
    this.#timer = undefined;
    this.#pending.clear();
  }

  #ensureTimer(): void {
    if (this.#closed || this.#timer !== undefined || this.#pending.size === 0) return;
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      this.#drainOnce();
    }, this.#retryDelayMs);
  }

  #drainOnce(): void {
    if (this.#closed) return;
    for (const [dumpId, item] of [...this.#pending]) {
      try {
        this.#processor.process(dumpId);
        this.#pending.delete(dumpId);
      } catch {
        item.attempts += 1;
        this.#totalRetries += 1;
        if (item.attempts >= this.#maxAttempts) {
          this.#pending.delete(dumpId);
          this.#exhausted += 1;
        }
      }
    }
    this.#ensureTimer();
  }
}
