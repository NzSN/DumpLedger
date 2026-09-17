/**
 * Symbols feature — the single HTTP seam for the operator Symbols page
 * (docs/symbols-design.md, "Ingest (operator surface)" and milestone 1).
 *
 * Wire vocabulary — record/ingest/list types, decoders, paths, the filename
 * header, the 8 GiB ceiling — is imported from `@dump-ledger/http-contracts`
 * (`symbols.ts`); this module re-declares nothing, so the page cannot drift
 * from the runtime-validated contract. List and purge ride the shared
 * client's `query`/`mutate`, which own the session cookie, the CSRF header,
 * and the stable error envelope.
 *
 * MARKED SEAM — operator raw upload.
 * The shared client's `upload()` is dump-intake-specific: it always sends
 * `x-upload-grant` plus `x-dump-filename-base64url`, never the operator CSRF
 * header, and decodes the dump 201/202 bodies. Symbol ingest is an operator
 * mutation of raw bytes with a caller-named filename header and its own 201
 * body, so this module binds to the shared client's additive `uploadRaw`
 * capability when the deployed client provides it and otherwise fails the
 * file with one stable, self-describing message (never a silent no-op).
 *
 * Required shared-client addition (additive; existing call sites untouched):
 *
 *   uploadRaw<T>(
 *     request: OperatorRawUploadRequest<T>,   // the shape declared below
 *     observer: UploadObserver,
 *   ): OperatorRawUploadHandle<T>
 *
 *   FetchHttpClient implements it with the XHR streaming path it already uses
 *   for `upload()`, setting `x-csrf-token` from the registered token source,
 *   sending the request's `filenameHeader` (base64url filename) instead of the
 *   dump header, and mapping a non-2xx envelope onto HttpRequestError exactly
 *   like `upload()` does. Once wired, `createSymbolsApi(useHttpClient())` is
 *   complete; nothing in the page or the queue changes.
 */

import {
  SYMBOLS_PATH,
  X_SYMBOL_FILENAME_HEADER,
  decodeSymbolIngestResponse,
  decodeSymbolListResponse,
  symbolPathForArtifact,
  type Decoder,
  type SymbolIngestResponse,
  type SymbolListResponse,
} from "@dump-ledger/http-contracts";
import {
  HttpRequestError,
  type SessionAwareHttpClient,
  type UploadObserver,
} from "../../shared/http-client";

/** Raw operator upload request (the additive shared-client capability). */
export interface OperatorRawUploadRequest<T> {
  readonly path: string;
  readonly file: Blob;
  /** Display-only filename; the transport base64url-encodes it in the header. */
  readonly filename: string;
  /** Header name carrying that base64url filename (e.g. x-symbol-filename-base64url). */
  readonly filenameHeader: string;
  /** Runtime decoder for the 201 JSON body (never a blind cast). */
  readonly decoder: Decoder<T>;
  readonly signal?: AbortSignal;
}

export interface OperatorRawUploadHandle<T> {
  readonly result: Promise<T>;
  abort(): void;
}

/** The shared client plus the raw-upload capability this feature needs. */
export type OperatorRawUploadClient = SessionAwareHttpClient & {
  readonly uploadRaw?: <T>(
    request: OperatorRawUploadRequest<T>,
    observer: UploadObserver,
  ) => OperatorRawUploadHandle<T>;
};

/** Stable operator-facing text when the deployed client cannot stream uploads. */
export const SYMBOL_INGEST_UNAVAILABLE_MESSAGE =
  "Symbol ingest is unavailable in this build: the HTTP client cannot stream operator uploads yet.";

export interface SymbolIngestOptions {
  /** Progress fraction in [0, 1]; only fires while the length is computable. */
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * Narrow interface the page and the ingest queue consume. One implementation
 * adapts the shared client; tests substitute a fake client with the same
 * observable behavior.
 */
export interface SymbolsApi {
  readonly listSymbols: (signal: AbortSignal) => Promise<SymbolListResponse>;
  /** Streams one file; resolves to the server-parsed identity (or dedup). */
  readonly ingestSymbol: (file: File, options?: SymbolIngestOptions) => Promise<SymbolIngestResponse>;
  /** Operator purge; resolves on 204 and surfaces envelope errors otherwise. */
  readonly purgeSymbol: (artifactId: string, signal?: AbortSignal) => Promise<void>;
}

export function createSymbolsApi(client: SessionAwareHttpClient): SymbolsApi {
  const rawClient = client as OperatorRawUploadClient;
  return {
    listSymbols(signal) {
      return client.query({ path: SYMBOLS_PATH, decoder: decodeSymbolListResponse, signal });
    },
    purgeSymbol(artifactId, signal) {
      return client.mutate<void>({
        path: symbolPathForArtifact(artifactId),
        method: "DELETE",
        ...(signal === undefined ? {} : { signal }),
      });
    },
    ingestSymbol(file, options = {}) {
      if (rawClient.uploadRaw === undefined) {
        throw new HttpRequestError(SYMBOL_INGEST_UNAVAILABLE_MESSAGE, {
          code: "internal_error",
          status: 0,
          retryable: false,
          path: SYMBOLS_PATH,
        });
      }
      const observer: UploadObserver =
        options.onProgress === undefined ? {} : { onProgress: options.onProgress };
      // Called on the client: the transport reads its registered CSRF token
      // source through `this`, so the method must not be detached.
      const handle = rawClient.uploadRaw<SymbolIngestResponse>(
        {
          path: SYMBOLS_PATH,
          file,
          filename: file.name,
          filenameHeader: X_SYMBOL_FILENAME_HEADER,
          decoder: decodeSymbolIngestResponse,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        observer,
      );
      return handle.result;
    },
  };
}
