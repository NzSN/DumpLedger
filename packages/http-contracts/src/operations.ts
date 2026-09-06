/**
 * Operations contracts (design section 7.7) for the authenticated
 * `GET /api/v1/operations` endpoint and the minimal unauthenticated
 * `GET /health` process check.
 *
 * The response is a local health summary only: it never exposes customer,
 * grant, or dump contents.
 */

import {
  arrayOf,
  booleanField,
  counterField,
  field,
  object,
  oneOf,
  text,
  type Decoder,
} from "./decode.js";

export const MAX_OPERATIONS_ERRORS = 50;
export const MAX_OPERATIONS_ERROR_LENGTH = 500;
export const MAX_OPERATIONS_JOBS = 64;
export const MAX_JOB_NAME_LENGTH = 128;

export const INTEGRITY_STATUSES = ["ok", "degraded"] as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

export interface RuntimeJobSummary {
  readonly name: string;
  readonly running: boolean;
  readonly runs: number;
  readonly failures: number;
}

const runtimeJobShape = {
  name: field(text({ max: MAX_JOB_NAME_LENGTH, label: "job name" })),
  running: field(booleanField()),
  runs: field(counterField("job runs")),
  failures: field(counterField("job failures")),
} as const;

export const decodeRuntimeJobSummary: Decoder<RuntimeJobSummary> = (value, path) => {
  const decoded = object(runtimeJobShape, "runtime job summary")(value, path);
  return {
    name: decoded.name,
    running: decoded.running,
    runs: decoded.runs,
    failures: decoded.failures,
  };
};

export function encodeRuntimeJobSummary(job: RuntimeJobSummary): Record<string, unknown> {
  return { name: job.name, running: job.running, runs: job.runs, failures: job.failures };
}

export interface OperationsResponse {
  readonly integrity: {
    readonly status: IntegrityStatus;
    readonly errorCount: number;
    readonly errors: readonly string[];
  };
  readonly uploads: { readonly active: number; readonly capacity: number };
  readonly postProcessing: { readonly pending: number; readonly exhausted: number; readonly totalRetries: number };
  readonly runtimeJobs: readonly RuntimeJobSummary[];
}

export const decodeOperationsResponse: Decoder<OperationsResponse> = (value, path) => {
  const decoded = object(
    {
      integrity: field((entry, entryPath) => {
        const integrity = object(
          {
            status: field(oneOf(INTEGRITY_STATUSES, "integrity status")),
            errorCount: field(counterField("integrity errorCount")),
            errors: field(
              arrayOf(text({ max: MAX_OPERATIONS_ERROR_LENGTH, label: "integrity error" }), {
                label: "integrity errors",
                maxLength: MAX_OPERATIONS_ERRORS,
              }),
            ),
          },
          "integrity summary",
        )(entry, entryPath);
        return {
          status: integrity.status,
          errorCount: integrity.errorCount,
          errors: integrity.errors,
        };
      }),
      uploads: field((entry, entryPath) => {
        const uploads = object(
          {
            active: field(counterField("active uploads")),
            capacity: field(counterField("upload capacity")),
          },
          "upload admission",
        )(entry, entryPath);
        return { active: uploads.active, capacity: uploads.capacity };
      }),
      postProcessing: field((entry, entryPath) => {
        const queue = object(
          {
            pending: field(counterField("pending post-processing")),
            exhausted: field(counterField("exhausted post-processing")),
            totalRetries: field(counterField("post-processing totalRetries")),
          },
          "post-processing queue",
        )(entry, entryPath);
        return {
          pending: queue.pending,
          exhausted: queue.exhausted,
          totalRetries: queue.totalRetries,
        };
      }),
      runtimeJobs: field(
        arrayOf(decodeRuntimeJobSummary, { label: "runtimeJobs", maxLength: MAX_OPERATIONS_JOBS }),
      ),
    },
    "operations response",
  )(value, path);
  return {
    integrity: {
      status: decoded.integrity.status,
      errorCount: decoded.integrity.errorCount,
      errors: decoded.integrity.errors,
    },
    uploads: { active: decoded.uploads.active, capacity: decoded.uploads.capacity },
    postProcessing: {
      pending: decoded.postProcessing.pending,
      exhausted: decoded.postProcessing.exhausted,
      totalRetries: decoded.postProcessing.totalRetries,
    },
    runtimeJobs: decoded.runtimeJobs,
  };
};

export function encodeOperationsResponse(response: OperationsResponse): Record<string, unknown> {
  return {
    integrity: {
      status: response.integrity.status,
      errorCount: response.integrity.errorCount,
      errors: response.integrity.errors,
    },
    uploads: { active: response.uploads.active, capacity: response.uploads.capacity },
    postProcessing: {
      pending: response.postProcessing.pending,
      exhausted: response.postProcessing.exhausted,
      totalRetries: response.postProcessing.totalRetries,
    },
    runtimeJobs: response.runtimeJobs.map(encodeRuntimeJobSummary),
  };
}

/** `GET /health` minimal unauthenticated process health. */
export interface HealthResponse {
  readonly status: "ok";
}

export const decodeHealthResponse: Decoder<HealthResponse> = (value, path) => {
  const decoded = object(
    { status: field(oneOf(["ok"], "health status")) },
    "health response",
  )(value, path);
  return { status: decoded.status as "ok" };
};

export function encodeHealthResponse(response: HealthResponse): Record<string, unknown> {
  return { status: response.status };
}
