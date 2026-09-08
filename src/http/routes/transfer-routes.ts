/**
 * Transfer routes (import/export design, "HTTP and UI surface"): operator
 * export bundles and verified server-local bundle imports.
 *
 *   POST   /api/v1/operations/exports           -> 201 { exportId }
 *   GET    /api/v1/operations/exports           -> bounded export list
 *   GET    /api/v1/operations/exports/:id/file  -> streamed tar download
 *   DELETE /api/v1/operations/exports/:id       -> { deleted: true }
 *   POST   /api/v1/operations/imports           -> 201 { importId }
 *   GET    /api/v1/operations/imports/:id       -> import progress counters
 *
 * The routes are registered only when the composition root provides a
 * TransferManager (`options.transfer`); without one these paths fall through
 * to the standard JSON 404 like every other unknown /api path.
 */

import { createReadStream, lstatSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  decodeCreateImportRequest,
  encodeCreateExportResponse,
  encodeCreateImportResponse,
  encodeDeleteExportResponse,
  encodeImportProgressResponse,
  encodeListExportsResponse,
  MAX_EXPORT_LIST_ITEMS,
  MAX_IMPORT_PATH_LENGTH,
} from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../../domain/errors.js";
import { contractErrorFor, decodeJsonRequest, jsonRequireMutation, jsonRequireSession, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Sealed bundle file name inside an export directory. Mirrors
 * BUNDLE_FINAL_NAME in src/transfer/manager.ts, which is not exported; the
 * manager owns the layout, this constant must not drift from it.
 */
const BUNDLE_FILE_NAME = "bundle.tar";

/**
 * Operator-feedback mirror of the bundle path policy the import pipeline
 * enforces authoritatively (checkBundlePath in src/transfer/import.ts:
 * resolved path, .tar suffix, existing regular file, never a symlink).
 * importBundle folds every failure — including these typed path errors — into
 * the returned job outcome, so without this pre-flight a bad path would
 * surface only as a failed import job instead of an immediate typed
 * 400/404. The pipeline remains the enforcing layer; this mirror exists so
 * the operator gets the pipeline's typed errors at request time. If the
 * pipeline policy changes, update both (reported as an IE4 hardening item).
 */
function assertImportBundlePath(raw: string): string {
  if (raw.length === 0 || raw.length > MAX_IMPORT_PATH_LENGTH) throw new DumpLedgerError("invalid_input", "bundle path is invalid");
  const path = resolve(raw);
  if (!path.endsWith(".tar")) throw new DumpLedgerError("invalid_input", "bundle path must end with .tar");
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new DumpLedgerError("not_found", "bundle path does not exist");
  }
  if (info.isSymbolicLink()) throw new DumpLedgerError("invalid_input", "bundle path must not be a symbolic link");
  if (!info.isFile()) throw new DumpLedgerError("invalid_input", "bundle path must be a regular file");
  return path;
}

/**
 * Maps a thrown transfer-layer failure onto the stable error envelope. Like
 * contractErrorFor, anything unexpected degrades to internal_error rather
 * than leaking an internal detail or bypassing the envelope.
 */
function transferError(reply: FastifyReply, error: unknown): FastifyReply {
  return sendError(reply, contractErrorFor(error instanceof DumpLedgerError ? error.code : "internal_error"));
}

export function registerTransferRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;
  const transfer = options.transfer;
  const exportsDir = options.transferExportsDir;
  if (transfer === undefined && exportsDir === undefined) return; // transfer surface disabled
  if (transfer === undefined || exportsDir === undefined) {
    throw new Error("HttpServerOptions.transfer and transferExportsDir must be provided together");
  }

  server.post("/api/v1/operations/exports", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    try {
      // The single-job claim is synchronous: a second job while one runs
      // throws invalid_transition (-> 409). The returned promise settles with
      // the terminal summary, which the manager records itself; the route
      // deliberately answers immediately (clients poll the list endpoint), so
      // the promise is not awaited. It never rejects today — failures land in
      // the recorded summary — the catch only guards the process if that ever
      // changes.
      void transfer.startExport().catch(() => undefined);
    } catch (error) {
      return transferError(reply, error);
    }
    // The claim succeeded, so exactly one export can be running and it is the
    // one just started: promise settlement is always asynchronous, so the
    // recorded entry cannot have left "running" yet.
    const running = transfer.listExports().find(summary => summary.status === "running");
    if (running === undefined) return sendError(reply, "internal_error");
    return reply
      .code(201)
      .type("application/json; charset=utf-8")
      .send(encodeCreateExportResponse({ exportId: running.exportId }));
  });

  server.get("/api/v1/operations/exports", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    // The registry sorts oldest-first; the bound keeps the most recent entries.
    const all = transfer.listExports();
    const exports = all.length > MAX_EXPORT_LIST_ITEMS ? all.slice(all.length - MAX_EXPORT_LIST_ITEMS) : all;
    return reply.type("application/json; charset=utf-8").send(encodeListExportsResponse({ exports }));
  });

  server.get<{ Params: { id: string } }>("/api/v1/operations/exports/:id/file", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const summary = transfer.getExport(request.params.id);
    if (summary === undefined) return sendError(reply, "not_found");
    if (summary.status !== "sealed") return sendError(reply, "invalid_transition");
    // Registry ids are always export_<32 hex> (the manager only ever creates
    // or loads that shape), so this join stays inside the exports directory.
    // The download filename is derived from that id, never from user input.
    const bundlePath = join(exportsDir, summary.exportId, BUNDLE_FILE_NAME);
    let byteSize: bigint;
    try {
      byteSize = statSync(bundlePath, { bigint: true }).size;
    } catch (error) {
      // Deleted between the registry lookup and the stat: treat as gone.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return sendError(reply, "not_found");
      throw error;
    }
    // Streamed, never buffered: bundles can be multi-GB.
    return reply
      .header("Content-Disposition", `attachment; filename="dump-ledger-export-${summary.exportId}.tar"`)
      .header("Content-Length", byteSize.toString())
      .type("application/x-tar")
      .send(createReadStream(bundlePath));
  });

  server.delete<{ Params: { id: string } }>("/api/v1/operations/exports/:id", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    try {
      transfer.deleteExport(request.params.id);
    } catch (error) {
      return transferError(reply, error);
    }
    return reply.type("application/json; charset=utf-8").send(encodeDeleteExportResponse({ deleted: true }));
  });

  server.post("/api/v1/operations/imports", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeCreateImportRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    try {
      const bundlePath = assertImportBundlePath(decoded.value.path);
      // IE4 hardening note: importBundle is synchronous — it verifies and
      // stages the entire bundle on the event loop before this response
      // (accepted for v1, design "Import pipeline"); a multi-GB import blocks
      // every other request until it settles. A bundle that passes path
      // policy but fails verification is still a started job: the response
      // carries its id and the failure detail surfaces via the progress
      // endpoint, matching the CreateImportResponse contract.
      const job = await transfer.startImport(bundlePath);
      return reply
        .code(201)
        .type("application/json; charset=utf-8")
        .send(encodeCreateImportResponse({ importId: job.importId }));
    } catch (error) {
      return transferError(reply, error);
    }
  });

  server.get<{ Params: { id: string } }>("/api/v1/operations/imports/:id", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const job = transfer.getImport(request.params.id);
    if (job === undefined) return sendError(reply, "not_found");
    return reply.type("application/json; charset=utf-8").send(encodeImportProgressResponse(job));
  });
}
