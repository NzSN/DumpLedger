import type { FastifyInstance, FastifyReply } from "fastify";

import {
  decodeDumpCatalogParams,
  encodeDumpCatalogResponse,
} from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../../domain/errors.js";
import { authorizeSessionOrAnalyzer, contractErrorFor, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Dump catalog read routes (docs/analyzer-integration-design.md, "Dump
 * catalog search" and "Conditional requests and dedup aids"; milestone AI1).
 *
 * `GET /api/v1/dumps` enumerates dumps across cases with the contract's
 * filter bag and opaque keyset cursor; `GET /api/v1/dumps/by-sha256/:sha256`
 * is the exact content-hash lookup for duplicate detection. Both are pure
 * application reads (no engine command, no audit event) guarded by
 * `authorizeSessionOrAnalyzer`: the operator session cookie or the configured
 * analyzer bearer token, with the pinned precedence that any `Authorization`
 * header selects the bearer path only.
 */

/**
 * Maps a thrown application failure onto the stable error envelope. Like
 * `contractErrorFor`, anything unexpected degrades to `internal_error` rather
 * than leaking an internal detail or bypassing the envelope. The catalog
 * queries throw `invalid_input` for malformed filters/cursors (a well-formed
 * but unknown identifier is an empty page, not an error).
 */
function catalogError(reply: FastifyReply, error: unknown): FastifyReply {
  return sendError(reply, contractErrorFor(error instanceof DumpLedgerError ? error.code : "internal_error"));
}

export function registerDumpCatalogRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;

  server.get("/api/v1/dumps", async (request, reply) => {
    if (authorizeSessionOrAnalyzer(request, reply, options) === undefined) return reply;
    let params;
    try {
      params = decodeDumpCatalogParams((request.query ?? {}) as Record<string, string | readonly string[] | undefined>);
    } catch {
      return sendError(reply, "invalid_request");
    }
    let response;
    try {
      response = options.application.searchDumps(params);
    } catch (error) {
      return catalogError(reply, error);
    }
    return reply.type("application/json; charset=utf-8").send(encodeDumpCatalogResponse(response));
  });

  // Registered as a literal path segment so find-my-way ranks it above
  // `/api/v1/dumps/:dumpId`; the two never overlap (`:dumpId` is one segment
  // shorter, and the content route's trailing literal is `content`).
  server.get<{ Params: { sha256: string } }>("/api/v1/dumps/by-sha256/:sha256", async (request, reply) => {
    if (authorizeSessionOrAnalyzer(request, reply, options) === undefined) return reply;
    let response;
    try {
      response = options.application.dumpsBySha256(request.params.sha256);
    } catch (error) {
      return catalogError(reply, error);
    }
    return reply.type("application/json; charset=utf-8").send(encodeDumpCatalogResponse(response));
  });
}
