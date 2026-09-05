type TimerHandle = unknown;

export interface RuntimeJobSnapshot {
  readonly name: string;
  readonly running: boolean;
  readonly runs: number;
  readonly failures: number;
}

export interface PeriodicRuntimeJobOptions {
  readonly name: string;
  readonly intervalMs: number;
  readonly run: () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (handle: TimerHandle) => void;
}

/** Recursive scheduling ensures a synchronous job never overlaps itself. */
export class PeriodicRuntimeJob {
  readonly #name: string;
  readonly #intervalMs: number;
  readonly #run: () => void;
  readonly #schedule: (callback: () => void, delayMs: number) => TimerHandle;
  readonly #cancel: (handle: TimerHandle) => void;
  #timer: TimerHandle | undefined;
  #started = false;
  #closed = false;
  #runs = 0;
  #failures = 0;

  constructor(options: PeriodicRuntimeJobOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1) throw new RangeError("runtime job interval must be positive");
    this.#name = options.name;
    this.#intervalMs = options.intervalMs;
    this.#run = options.run;
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#scheduleNext();
  }

  snapshot(): RuntimeJobSnapshot {
    return { name: this.#name, running: this.#started && !this.#closed, runs: this.#runs, failures: this.#failures };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) this.#cancel(this.#timer);
    this.#timer = undefined;
  }

  #scheduleNext(): void {
    if (this.#closed) return;
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      this.#runs += 1;
      try { this.#run(); } catch { this.#failures += 1; }
      this.#scheduleNext();
    }, this.#intervalMs);
  }
}
