import type { FastifyInstance } from "fastify";

import {
  decodeCreateCaseRequest,
  decodeCreateCustomerRequest,
  encodeCaseSummary,
  encodeCreateCustomerResponse,
  encodeDashboardResponse,
} from "@dump-ledger/http-contracts";
import { contractErrorFor, decodeJsonRequest, jsonRequireMutation, jsonRequireSession, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Customer, dashboard, and create-case routes (design section 7.3).
 *
 * The JSON dashboard and create mutations use the bounded application-port
 * query methods; no /api route reads the whole engine projection. The legacy
 * HTML dashboard/customer pages were deleted in the Phase-5 cutover; `/` and
 * `/customers` now serve the React shell from static-web.
 */
export function registerCustomerRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;

  server.get("/api/v1/dashboard", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const dashboard = options.application.dashboard();
    return reply.type("application/json; charset=utf-8").send(encodeDashboardResponse(dashboard));
  });

  server.post("/api/v1/customers", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeCreateCustomerRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    const result = options.application.createCustomer(decoded.value.displayName);
    if (!result.ok || result.id === undefined) {
      return sendError(reply, result.ok ? "internal_error" : contractErrorFor(result.code));
    }
    return reply
      .code(201)
      .type("application/json; charset=utf-8")
      .send(
        encodeCreateCustomerResponse({
          customer: { customerId: result.id, displayName: decoded.value.displayName },
        }),
      );
  });

  server.post<{ Params: { customerId: string } }>("/api/v1/customers/:customerId/cases", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeCreateCaseRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    const result = options.application.createCase(request.params.customerId, decoded.value.title);
    if (!result.ok || result.id === undefined) {
      return sendError(reply, result.ok ? "internal_error" : contractErrorFor(result.code));
    }
    const summary = options.application.caseSummary(result.id);
    if (summary === undefined) return sendError(reply, "internal_error");
    return reply.code(201).type("application/json; charset=utf-8").send(encodeCaseSummary(summary));
  });
}
