import type { FastifyInstance } from "fastify";

import {
  encodeOperationsResponse,
  MAX_OPERATIONS_ERRORS,
  MAX_OPERATIONS_ERROR_LENGTH,
} from "@dump-ledger/http-contracts";
import { jsonRequireSession } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Operations routes (design section 7.7). `GET /api/v1/operations` is the
 * bounded authenticated JSON summary consumed by the React shell; it never
 * exposes customer, grant, or dump contents. The legacy `/operations` page and
 * `/operations/health` JSON were deleted in the Phase-5 cutover; `/operations`
 * now serves the React shell from static-web.
 */
export function registerOperationRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options, uploadAdmission } = ctx;

  function boundedIntegrityErrors(): string[] {
    return options.application
      .operations()
      .integrityErrors.slice(0, MAX_OPERATIONS_ERRORS)
      .map(error => error.slice(0, MAX_OPERATIONS_ERROR_LENGTH));
  }

  server.get("/api/v1/operations", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const errors = boundedIntegrityErrors();
    return reply
      .type("application/json; charset=utf-8")
      .send(
        encodeOperationsResponse({
          integrity: {
            status: errors.length === 0 ? "ok" : "degraded",
            errorCount: errors.length,
            errors,
          },
          uploads: uploadAdmission.snapshot(),
          postProcessing: options.postProcessingQueue?.snapshot() ?? { pending: 0, exhausted: 0, totalRetries: 0 },
          runtimeJobs: options.runtimeJobs?.map(job => job.snapshot()) ?? [],
        }),
      );
  });
}
