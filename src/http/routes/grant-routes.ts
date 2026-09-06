import type { FastifyInstance } from "fastify";

import {
  decodeCreateGrantRequest,
  encodeCreateGrantResponse,
  encodeRevokeGrantResponse,
} from "@dump-ledger/http-contracts";
import { contractErrorFor, decodeJsonRequest, jsonRequireMutation, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Grant issuance and revocation routes (design section 7.5).
 *
 * The JSON endpoints return the one-time relative `uploadPath`
 * (`/upload#grant=<base64url-secret>`) that the React shell turns into a
 * shareable URL from `location.origin`. The legacy path-secret HTML grant
 * flow was deleted in the Phase-5 cutover.
 */
export function registerGrantRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options, now } = ctx;

  server.post<{ Params: { caseId: string } }>("/api/v1/cases/:caseId/grants", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeCreateGrantRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    const serverTime = now();
    if (!Number.isSafeInteger(serverTime) || serverTime < 0) return sendError(reply, "internal_error");
    const expiresAt = serverTime + decoded.value.validForHours * 3_600_000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= serverTime) return sendError(reply, "invalid_request");
    const result = options.application.issueGrant(request.params.caseId, expiresAt, decoded.value.maxBytes);
    if (!result.ok || result.id === undefined || result.secret === undefined) {
      return sendError(reply, result.ok ? "internal_error" : contractErrorFor(result.code));
    }
    const record = options.application.grantRecord(result.id);
    if (record === undefined || record.state !== "issued") return sendError(reply, "internal_error");
    return reply
      .code(201)
      .type("application/json; charset=utf-8")
      .send(
        encodeCreateGrantResponse({
          grant: { ...record, state: "issued" },
          uploadPath: `/upload#grant=${result.secret}`,
        }),
      );
  });

  server.post<{ Params: { grantId: string } }>("/api/v1/grants/:grantId/revoke", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const result = options.application.revokeGrant(request.params.grantId);
    if (!result.ok) return sendError(reply, contractErrorFor(result.code));
    const record = options.application.grantRecord(request.params.grantId);
    if (record === undefined || record.state !== "revoked") return sendError(reply, "internal_error");
    return reply.type("application/json; charset=utf-8").send(
      encodeRevokeGrantResponse({
        grant: { ...record, state: "revoked" },
      }),
    );
  });
}
