import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type IntakeErrorCode =
  | "grant_invalid"
  | "upload_too_large"
  | "upload_incomplete"
  | "storage_unavailable"
  | "integrity_failure";

export class IntakeError extends Error {
  constructor(readonly code: IntakeErrorCode, message = code) {
    super(message);
    this.name = "IntakeError";
  }
}

export interface UploadLifecyclePort {
  begin(input: { readonly grantSecret: string; readonly originalName: string }):
    | { readonly ok: true; readonly dumpId: string; readonly maxBytes: bigint }
    | { readonly ok: false; readonly code: string };
  seal(input: { readonly dumpId: string; readonly byteSize: bigint; readonly sha256: string }):
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string };
  fail(input: { readonly dumpId: string; readonly reason: string }):
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string };
}

export interface UploadByteSink {
  append(dumpId: string, chunk: Uint8Array): void;
  syncAndClose(dumpId: string): void;
}

export interface ReceiveUpload {
  readonly grantSecret: string;
  readonly originalName: string;
  readonly contentLength?: bigint;
  readonly bytes: NodeJS.ReadableStream;
}

export interface UploadReceipt {
  readonly dumpId: string;
  readonly byteSize: bigint;
  readonly sha256: string;
}

class UploadLimitExceeded extends Error {}
class UploadStorageFailure extends Error {}

export class UploadSession {
  constructor(
    private readonly lifecycle: UploadLifecyclePort,
    private readonly sink: UploadByteSink,
  ) {}

  async receive(input: ReceiveUpload): Promise<UploadReceipt> {
    const begun = this.lifecycle.begin({
      grantSecret: input.grantSecret,
      originalName: input.originalName,
    });
    if (!begun.ok) throw new IntakeError("grant_invalid");

    const { dumpId, maxBytes } = begun;
    if (input.contentLength !== undefined && input.contentLength > maxBytes) {
      const failed = this.lifecycle.fail({ dumpId, reason: "upload_too_large" });
      if (!failed.ok) throw new IntakeError("integrity_failure");
      throw new IntakeError("upload_too_large");
    }

    const hash = createHash("sha256");
    let byteSize = 0n;
    const destination = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        try {
          byteSize += BigInt(chunk.byteLength);
          if (byteSize > maxBytes) throw new UploadLimitExceeded();
          hash.update(chunk);
          try {
            this.sink.append(dumpId, chunk);
          } catch (error) {
            throw new UploadStorageFailure(String(error));
          }
          done();
        } catch (error) {
          done(error as Error);
        }
      },
    });

    try {
      await pipeline(input.bytes, destination);
      try {
        this.sink.syncAndClose(dumpId);
      } catch (error) {
        throw new UploadStorageFailure(String(error));
      }
      const sha256 = hash.digest("hex");
      const sealed = this.lifecycle.seal({ dumpId, byteSize, sha256 });
      if (!sealed.ok) throw new IntakeError("storage_unavailable");
      return { dumpId, byteSize, sha256 };
    } catch (error) {
      const failed = this.lifecycle.fail({
        dumpId,
        reason: error instanceof UploadLimitExceeded
          ? "upload_too_large"
          : error instanceof UploadStorageFailure
            ? "storage_unavailable"
            : "upload_incomplete",
      });
      if (!failed.ok) throw new IntakeError("integrity_failure");
      if (error instanceof IntakeError) throw error;
      if (error instanceof UploadLimitExceeded) throw new IntakeError("upload_too_large");
      if (error instanceof UploadStorageFailure) throw new IntakeError("storage_unavailable");
      throw new IntakeError("upload_incomplete");
    }
  }
}
