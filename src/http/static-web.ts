/**
 * Production static serving for the Vite build (design sections 5.4 and 9).
 *
 * This module is the only place that touches `dist/web` on disk. It serves
 * hashed `/assets/*` files with long-lived immutable caching and serves
 * `index.html` (no-store) for exactly the browser routes the React Router
 * defines (design section 6) plus their single-segment detail subpaths:
 * `/cases/:caseId` and `/dumps/:dumpId`.
 *
 * The SPA fallback is an explicit allow-list, never a wildcard: an unknown
 * `/api/*`, `/health`, legacy `/upload/:secret`, manifest, or download path
 * stays on Fastify's default JSON 404 rather than being converted into HTML.
 * `buildHttpServer` remains the composition interface; server-side HTML
 * rendering no longer exists after the Phase-5 cutover.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import { sendError } from "./contracts/json.js";
import type { HttpServerOptions } from "./server.js";

/** Browser routes served by the React app (frontend/src/app/router.tsx). */
const INDEX_ROUTES: readonly string[] = [
  "/",
  "/login",
  "/upload",
  "/customers",
  "/cases",
  "/cases/:caseId",
  "/dumps",
  "/dumps/:dumpId",
  "/operations",
];

/**
 * Hashed Vite assets live flat under `dist/web/assets`. The strict basename
 * keeps a single path segment (Fastify params cannot contain `/`) and rejects
 * traversal attempts regardless.
 */
const ASSET_BASENAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/** Reads a file from the static root; any read failure is a JSON 404, never an HTML fallback. */
async function sendFile(reply: FastifyReply, filePath: string): Promise<void> {
  const bytes = await readFile(filePath).catch(() => undefined);
  if (bytes === undefined) return sendError(reply, "not_found");
  return reply.type(contentTypeFor(filePath)).send(bytes);
}

/** Serves `index.html` with an explicit no-store (the global hook also enforces it). */
async function sendIndex(reply: FastifyReply, webRoot: string): Promise<void> {
  const bytes = await readFile(join(webRoot, "index.html")).catch(() => undefined);
  if (bytes === undefined) return sendError(reply, "not_found");
  return reply
    .header("Cache-Control", "no-store")
    .type("text/html; charset=utf-8")
    .send(bytes);
}

/**
 * Registers static serving on the composed server. Call after the /api and
 * /health registrations so the route table reads API first, then browser UI.
 * No service worker is registered anywhere.
 */
export function registerStaticWeb(server: FastifyInstance, options: HttpServerOptions): void {
  const webRoot = options.webRoot ?? resolve(process.cwd(), "dist", "web");

  // Hashed assets: immutable, long-lived, content-typed. Errors are 404 JSON.
  server.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => {
    const file = request.params.file;
    if (!ASSET_BASENAME.test(file) || file === "." || file === "..") {
      return sendError(reply, "not_found");
    }
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return sendFile(reply, join(webRoot, "assets", file));
  });

  // SPA shell for exactly the browser routes the React Router defines.
  for (const route of INDEX_ROUTES) {
    server.get(route, async (_request, reply) => sendIndex(reply, webRoot));
  }
}
