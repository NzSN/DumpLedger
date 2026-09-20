import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface UploadTimeouts {
  readonly idleMs: number;
  readonly totalMs: number;
}

export const DEFAULT_UPLOAD_TIMEOUTS: UploadTimeouts = { idleMs: 60_000, totalMs: 60 * 60_000 };

export function validateUploadTimeouts(timeouts: UploadTimeouts): UploadTimeouts {
  for (const value of [timeouts.idleMs, timeouts.totalMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new RangeError("upload timeouts must be positive milliseconds no greater than 2147483647");
    }
  }
  return { ...timeouts };
}

/** A shared deadline for both dump and symbol streams. Aborting the pipeline
 * destroys its streams, so callers' existing failure/finally paths remove
 * staging bytes and release admission. A trickle resets only the idle timer.
 * Timers cover time waiting for data AND downstream backpressure. */
export async function boundedPipeline(
  source: NodeJS.ReadableStream,
  destination: NodeJS.WritableStream,
  options: UploadTimeouts = DEFAULT_UPLOAD_TIMEOUTS,
  onTimeout?: () => void,
): Promise<void> {
  const timeouts = validateUploadTimeouts(options);
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted) return;
    // Fastify may supply a parser wrapper rather than the raw HTTP stream.
    // Its destruction alone does not close an unfinished HTTP request.
    // Close the transport first: pipeline abort can detach the HTTP socket
    // from IncomingMessage before a subsequent callback can reach it.
    try { onTimeout?.(); } finally { controller.abort(); }
  };
  const idle = setTimeout(abort, timeouts.idleMs);
  const total = setTimeout(abort, timeouts.totalMs);
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      idle.refresh();
      done(null, chunk);
    },
  });
  try {
    await pipeline(source, progress, destination, { signal: controller.signal });
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}
