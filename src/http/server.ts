import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Readable } from "node:stream";

import { FixedWindowRateLimiter } from "../auth/rate-limiter.js";
import { type OperatorSession, OperatorSessions } from "../auth/sessions.js";
import { UploadAdmission } from "../intake/upload-admission.js";
import type { UploadPostProcessor } from "../intake/intake-facade.js";
import type { PostProcessingQueue } from "../intake/post-processing-queue.js";
import { IntakeError, UploadSession, type UploadByteSink, type UploadLifecyclePort } from "../intake/upload-session.js";
import type { RuntimeJobSnapshot } from "./runtime-jobs.js";
import { appCss } from "./views/app.css.js";
import { appScript } from "./views/app-script.js";
import { escapeHtml, page } from "./views/page.js";
import { uploadScript } from "./views/upload-script.js";

const RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RETENTION_DAYS = 36_500;

export interface CustomerView { readonly customerId: string; readonly displayName: string }
export interface CaseView { readonly caseId: string; readonly customerId: string; readonly title: string; readonly status: string }
export interface GrantView { readonly grantId: string; readonly caseId: string; readonly state: string; readonly expiresAt: number; readonly maxBytes: bigint }
export interface DumpView { readonly dumpId: string; readonly caseId: string; readonly phase: string; readonly byteSize?: bigint; readonly coverage?: string; readonly purgeAt?: string }
export interface AuditView { readonly action: string; readonly occurredAt: number; readonly caseId?: string; readonly dumpId?: string; readonly outcome?: string }

export interface HttpProjection {
  readonly customers: CustomerView[];
  readonly cases: CaseView[];
  readonly grants: GrantView[];
  readonly dumps: DumpView[];
  readonly auditEvents: AuditView[];
}

type MutationResult = { readonly ok: true; readonly id?: string; readonly secret?: string } | { readonly ok: false; readonly code: string };

export interface HttpApplicationPort {
  snapshot(): HttpProjection;
  createCustomer(displayName: string): MutationResult;
  createCase(customerId: string, title: string): MutationResult;
  issueGrant(caseId: string, expiresAt: number, maxBytes: bigint): MutationResult;
  revokeGrant(grantId: string): MutationResult;
  setRetention(dumpId: string, purgeAt: string): MutationResult;
  caseManifest(caseId: string): unknown;
  openDownload(dumpId: string): { readonly phase: string; readonly byteSize: bigint; readonly bytes: Readable } | undefined;
  operations?(): { readonly integrityErrors: readonly string[] };
}

export interface HttpServerOptions {
  readonly application: HttpApplicationPort;
  readonly sessions: OperatorSessions;
  readonly uploadLifecycle: UploadLifecyclePort;
  readonly uploadSink: UploadByteSink;
  readonly now?: () => number;
  readonly uploadPostProcessor?: UploadPostProcessor;
  readonly postProcessingQueue?: PostProcessingQueue;
  readonly uploadAdmission?: UploadAdmission;
  readonly maxConcurrentUploads?: number;
  readonly loginRateLimiter?: FixedWindowRateLimiter;
  readonly uploadGrantRateLimiter?: FixedWindowRateLimiter;
  readonly secureDeployment?: boolean;
  readonly runtimeJobs?: readonly { snapshot(): RuntimeJobSnapshot }[];
}

function formBody(request: FastifyRequest): URLSearchParams {
  return new URLSearchParams(typeof request.body === "string" ? request.body : "");
}

function sessionFor(request: FastifyRequest, sessions: OperatorSessions): OperatorSession | undefined {
  return sessions.authenticate(request.headers.cookie);
}

function requireOperator(request: FastifyRequest, reply: FastifyReply, sessions: OperatorSessions): OperatorSession | undefined {
  const session = sessionFor(request, sessions);
  if (session === undefined) void reply.code(303).redirect("/login");
  return session;
}

function requireCsrf(request: FastifyRequest, reply: FastifyReply, sessions: OperatorSessions): OperatorSession | undefined {
  const session = requireOperator(request, reply, sessions);
  if (session === undefined) return undefined;
  if (!sessions.verifyCsrf(session, formBody(request).get("csrf") ?? undefined)) {
    void reply.code(403).type("text/plain").send("Forbidden");
    return undefined;
  }
  return session;
}

function validSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function headerText(value: string | string[] | undefined, fallback: string): string {
  const selected = Array.isArray(value) ? value[0] : value;
  if (selected === undefined || selected.length === 0 || selected.length > 255 || /[\0\r\n]/.test(selected)) return fallback;
  return selected;
}

function formatBytes(value: bigint | undefined): string {
  if (value === undefined) return "Unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
  let unitIndex = 0;
  let scale = 1n;
  while (unitIndex < units.length - 1 && value >= scale * 1024n) {
    scale *= 1024n;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${value} B`;
  const whole = value / scale;
  const decimal = (value % scale) * 10n / scale;
  return `${whole}${decimal === 0n ? "" : `.${decimal}`} ${units[unitIndex]}`;
}

function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "Unknown";
  return new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function statusTone(value: string): "good" | "info" | "warn" | "bad" | "muted" {
  if (["available", "valid", "resolved", "consumed", "ok"].includes(value)) return "good";
  if (["new", "investigating", "receiving", "sealed", "issued", "running"].includes(value)) return "info";
  if (["quarantined", "waiting-for-customer", "deleting", "degraded"].includes(value)) return "warn";
  if (["rejected", "invalid", "transfer-failed", "failed"].includes(value)) return "bad";
  return "muted";
}

function statusPill(value: string): string {
  return `<span class="status status-${statusTone(value)}">${escapeHtml(value.replaceAll("-", " "))}</span>`;
}

function emptyState(title: string, copy: string): string {
  return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span></div>`;
}

function auditTimeline(events: readonly AuditView[]): string {
  if (events.length === 0) return emptyState("No activity yet", "Lifecycle events will appear here.");
  return `<ol class="timeline">${[...events].reverse().slice(0, 12).map(event => `<li class="timeline-item">
    <span class="timeline-title">${escapeHtml(event.action.replaceAll(/([a-z])([A-Z])/g, "$1 $2"))}${event.outcome === undefined ? "" : ` · ${escapeHtml(event.outcome)}`}</span>
    <time class="timeline-time" datetime="${new Date(event.occurredAt).toISOString()}">${escapeHtml(formatDate(event.occurredAt))}</time>
  </li>`).join("")}</ol>`;
}

function renderHome(projection: HttpProjection, csrf: string): string {
  const customerNames = new Map(projection.customers.map(customer => [customer.customerId, customer.displayName]));
  const activeCases = projection.cases.filter(item => !["resolved", "closed"].includes(item.status)).length;
  const availableDumps = projection.dumps.filter(dump => dump.phase === "available").length;
  const processingDumps = projection.dumps.filter(dump => ["receiving", "sealed", "quarantined", "deleting"].includes(dump.phase)).length;
  const cases = projection.cases.length === 0
    ? emptyState("No cases yet", "Create a customer, then open the first investigation.")
    : `<div class="case-list">${[...projection.cases].reverse().map(item => `<a class="case-row" href="/cases/${encodeURIComponent(item.caseId)}">
        <span><span class="case-title">${escapeHtml(item.title)}</span><span class="case-meta"><span>${escapeHtml(customerNames.get(item.customerId) ?? "Unknown customer")}</span><span class="mono subtle-id">${escapeHtml(item.caseId)}</span></span></span>
        ${statusPill(item.status)}
      </a>`).join("")}</div>`;
  const customers = projection.customers.length === 0
    ? emptyState("No customers yet", "Add the organization or person supplying crash evidence.")
    : `<div class="customer-list">${projection.customers.map(customer => `<section class="customer-card">
        <div><span class="customer-name">${escapeHtml(customer.displayName)}</span><div class="mono subtle-id">${escapeHtml(customer.customerId)}</div></div>
        <form method="post" action="/customers/${encodeURIComponent(customer.customerId)}/cases" class="inline-create">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <label class="field"><span class="field-label">New case</span><span class="inline-field"><input name="title" required maxlength="300" placeholder="Renderer crash on startup"><button class="button button-secondary button-small" type="submit">Create</button></span></label>
        </form>
      </section>`).join("")}</div>`;

  return page("Cases", `
    <header class="page-heading">
      <div><p class="eyebrow">Evidence intake</p><h1>Cases</h1><p>Keep every minidump tied to the customer and investigation that produced it.</p></div>
      <div class="heading-actions"><a class="button button-secondary" href="/operations">System health</a></div>
    </header>
    <section class="metric-grid" aria-label="Overview">
      <div class="metric"><span class="metric-label">Active cases</span><strong class="metric-value">${activeCases}</strong><span class="metric-note">Investigations in flight</span></div>
      <div class="metric"><span class="metric-label">Available dumps</span><strong class="metric-value">${availableDumps}</strong><span class="metric-note">Validated for analysis</span></div>
      <div class="metric"><span class="metric-label">Processing</span><strong class="metric-value">${processingDumps}</strong><span class="metric-note">In durable lifecycle</span></div>
      <div class="metric"><span class="metric-label">Customers</span><strong class="metric-value">${projection.customers.length}</strong><span class="metric-note">Tracked identities</span></div>
    </section>
    <div class="layout-grid">
      <section class="panel"><header class="panel-header"><div><h2>Recent cases</h2><p>Open an investigation to issue links and review dumps.</p></div><span class="panel-count">${projection.cases.length}</span></header>${cases}</section>
      <div class="stack">
        <section class="panel"><header class="panel-header"><div><h2>Customers</h2><p>Create a case directly under its owner.</p></div></header>${customers}</section>
        <section class="panel panel-accent"><header class="panel-header"><div><h2>Add customer</h2><p>Names stay in metadata, never vault paths.</p></div></header><div class="panel-body">
          <form method="post" action="/customers" class="form-stack"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label class="field"><span class="field-label">Display name</span><input name="displayName" required maxlength="200" placeholder="Acme Support"></label><button class="button" type="submit">Add customer</button></form>
        </div></section>
      </div>
    </div>`, { chrome: "operator", csrfToken: csrf, wide: true });
}

export function buildHttpServer(options: HttpServerOptions): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const upload = new UploadSession(options.uploadLifecycle, options.uploadSink);
  const now = options.now ?? Date.now;
  const uploadAdmission = options.uploadAdmission ?? new UploadAdmission(options.maxConcurrentUploads ?? 2);
  const loginRateLimiter = options.loginRateLimiter ?? new FixedWindowRateLimiter({ limit: 10, windowMs: 5 * 60_000, maxKeys: 2_048, now });
  const uploadGrantRateLimiter = options.uploadGrantRateLimiter ?? new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 4_096, now });

  server.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));
  server.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  server.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!request.url.startsWith("/assets/")) reply.header("Cache-Control", "no-store");
    if (options.secureDeployment === true) reply.header("Strict-Transport-Security", "max-age=31536000");
    return payload;
  });

  server.get("/health", async () => ({ status: "ok" }));
  server.get("/assets/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(appCss));
  server.get("/assets/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(appScript));
  server.get("/assets/upload.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(uploadScript));
  server.get("/login", async (_request, reply) => reply.type("text/html; charset=utf-8").send(page("Sign in", `
    <section class="auth-shell">
      <div class="auth-card">
        <span class="auth-symbol" aria-hidden="true">⌁</span>
        <p class="eyebrow">Operator access</p>
        <h1>Welcome back</h1>
        <p>Sign in to manage customers, cases, upload grants, and retained evidence.</p>
        <form method="post" class="form-stack auth-form">
          <label class="field"><span class="field-label">Operator password</span><input type="password" name="password" required autocomplete="current-password" autofocus></label>
          <button class="button" type="submit">Open evidence vault</button>
        </form>
        <div class="auth-footnote"><span class="trust-dot"></span>Credentials stay within this DumpLedger instance.</div>
      </div>
    </section>`, { chrome: "public", bodyClass: "auth-page" })));
  server.post("/login", async (request, reply) => {
    if (!loginRateLimiter.take(request.ip)) return reply.header("Retry-After", "300").code(429).send("Too many authentication attempts");
    const loggedIn = await options.sessions.login(formBody(request).get("password") ?? "");
    if (loggedIn === undefined) return reply.code(401).type("text/plain").send("Authentication failed");
    return reply.header("Set-Cookie", loggedIn.setCookie).code(303).redirect("/");
  });
  server.post("/logout", async (request, reply) => {
    const session = requireCsrf(request, reply, options.sessions);
    if (session === undefined) return reply;
    return reply.header("Set-Cookie", options.sessions.logout(session)).code(303).redirect("/login");
  });

  server.get("/", async (request, reply) => {
    const session = requireOperator(request, reply, options.sessions);
    if (session === undefined) return reply;
    return reply.type("text/html; charset=utf-8").send(renderHome(options.application.snapshot(), session.csrfToken));
  });
  server.post("/customers", async (request, reply) => {
    if (requireCsrf(request, reply, options.sessions) === undefined) return reply;
    const name = formBody(request).get("displayName")?.trim() ?? "";
    if (name.length === 0 || name.length > 200) return reply.code(400).send("Invalid customer name");
    const result = options.application.createCustomer(name);
    return result.ok ? reply.code(303).redirect("/") : reply.code(409).send(result.code);
  });
  server.post<{ Params: { customerId: string } }>("/customers/:customerId/cases", async (request, reply) => {
    if (requireCsrf(request, reply, options.sessions) === undefined) return reply;
    const title = formBody(request).get("title")?.trim() ?? "";
    if (title.length === 0 || title.length > 300) return reply.code(400).send("Invalid case title");
    const result = options.application.createCase(request.params.customerId, title);
    return result.ok && result.id !== undefined
      ? reply.code(303).redirect(`/cases/${encodeURIComponent(result.id)}`)
      : reply.code(409).send(result.ok ? "case_creation_failed" : result.code);
  });
  server.get<{ Params: { caseId: string } }>("/cases/:caseId", async (request, reply) => {
    const session = requireOperator(request, reply, options.sessions);
    if (session === undefined) return reply;
    const projection = options.application.snapshot();
    const item = projection.cases.find(candidate => candidate.caseId === request.params.caseId);
    if (item === undefined) return reply.code(404).send("Case not found");
    const customer = projection.customers.find(candidate => candidate.customerId === item.customerId);
    const caseDumps = projection.dumps.filter(dump => dump.caseId === item.caseId);
    const caseGrants = projection.grants.filter(grant => grant.caseId === item.caseId);
    const caseAudits = projection.auditEvents.filter(event => event.caseId === item.caseId);
    const dumps = caseDumps.length === 0
      ? emptyState("No dumps attached", "Create a one-time upload link to collect the first minidump.")
      : `<div class="record-list">${[...caseDumps].reverse().map(dump => `<div class="record-row"><div class="record-main"><a class="record-title mono" href="/dumps/${encodeURIComponent(dump.dumpId)}">${escapeHtml(dump.dumpId)}</a><div class="record-meta"><span>${escapeHtml(formatBytes(dump.byteSize))}</span><span>${escapeHtml(dump.coverage ?? "unclassified")}</span>${dump.purgeAt === undefined ? "" : `<span>purge ${escapeHtml(dump.purgeAt)}</span>`}</div></div>${statusPill(dump.phase)}</div>`).join("")}</div>`;
    const grants = caseGrants.length === 0
      ? emptyState("No active links", "Upload grants are one-time and case-bound.")
      : `<div class="record-list">${[...caseGrants].reverse().map(grant => `<div class="record-row"><div class="record-main"><span class="record-title mono">${escapeHtml(grant.grantId)}</span><div class="record-meta"><span>Expires ${escapeHtml(formatDate(grant.expiresAt))}</span><span>${escapeHtml(formatBytes(grant.maxBytes))} max</span></div></div><div class="record-actions">${statusPill(grant.state)}${grant.state === "issued" ? `<form method="post" action="/grants/${encodeURIComponent(grant.grantId)}/revoke" class="compact-form"><input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}"><button class="button button-danger button-small" type="submit">Revoke</button></form>` : ""}</div></div>`).join("")}</div>`;
    return reply.type("text/html; charset=utf-8").send(page(item.title, `
      <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Cases</a><span>/</span><span>${escapeHtml(item.title)}</span></nav>
      <header class="page-heading"><div><p class="eyebrow">${escapeHtml(customer?.displayName ?? "Customer case")}</p><h1>${escapeHtml(item.title)}</h1><p class="mono subtle-id">${escapeHtml(item.caseId)}</p></div><div class="heading-actions">${statusPill(item.status)}<a class="button button-secondary" href="/cases/${encodeURIComponent(item.caseId)}/manifest.json">Export manifest</a></div></header>
      <section class="metric-grid metric-grid-three" aria-label="Case summary">
        <div class="metric"><span class="metric-label">Dumps</span><strong class="metric-value">${caseDumps.length}</strong><span class="metric-note">${caseDumps.filter(dump => dump.phase === "available").length} available</span></div>
        <div class="metric"><span class="metric-label">Upload grants</span><strong class="metric-value">${caseGrants.length}</strong><span class="metric-note">${caseGrants.filter(grant => grant.state === "issued").length} active</span></div>
        <div class="metric"><span class="metric-label">Activity</span><strong class="metric-value">${caseAudits.length}</strong><span class="metric-note">Audited lifecycle events</span></div>
      </section>
      <div class="layout-grid">
        <div class="stack"><section class="panel"><header class="panel-header"><div><h2>Crash dumps</h2><p>Original bytes are immutable after validation.</p></div></header>${dumps}</section><section class="panel"><header class="panel-header"><div><h2>Activity</h2><p>Most recent case events.</p></div></header><div class="panel-body panel-body-flush">${auditTimeline(caseAudits)}</div></section></div>
        <div class="stack"><section class="panel panel-accent"><header class="panel-header"><div><h2>Create upload link</h2><p>One customer, one case, one upload.</p></div></header><div class="panel-body"><form method="post" action="/cases/${encodeURIComponent(item.caseId)}/grants" class="form-stack"><input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}"><label class="field"><span class="field-label">Valid for</span><span class="inline-suffix"><input type="number" name="hours" min="1" max="168" value="24"><span>hours</span></span></label><label class="field"><span class="field-label">Maximum bytes</span><input type="number" name="maxBytes" min="1" value="10737418240"><span class="field-hint">Default: 10 GiB. Full-memory dumps can be large.</span></label><button class="button" type="submit">Generate secure link</button></form></div></section><section class="panel"><header class="panel-header"><div><h2>Upload grants</h2><p>Secrets are shown only at creation.</p></div></header>${grants}</section></div>
      </div>`, { chrome: "operator", csrfToken: session.csrfToken, wide: true }));
  });
  server.post<{ Params: { caseId: string } }>("/cases/:caseId/grants", async (request, reply) => {
    const session = requireCsrf(request, reply, options.sessions);
    if (session === undefined) return reply;
    const form = formBody(request);
    const hours = Number(form.get("hours"));
    let maxBytes: bigint;
    try { maxBytes = BigInt(form.get("maxBytes") ?? "0"); } catch { return reply.code(400).send("Invalid maximum size"); }
    if (!Number.isInteger(hours) || hours < 1 || hours > 168 || maxBytes <= 0n) return reply.code(400).send("Invalid grant policy");
    const result = options.application.issueGrant(request.params.caseId, now() + hours * 3_600_000, maxBytes);
    if (!result.ok || result.secret === undefined) return reply.code(409).send(result.ok ? "grant_creation_failed" : result.code);
    const link = `/upload/${encodeURIComponent(result.secret)}`;
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store").send(page("Upload link", `
      <section class="success-shell"><div class="success-card">
        <span class="success-symbol" aria-hidden="true">✓</span>
        <p class="eyebrow">Grant created</p><h1>Upload link ready</h1>
        <p>This bearer link is tied to one case and is consumed when an upload begins.</p>
        <label class="field"><span class="field-label">Share this complete link privately</span><span class="copy-row"><input id="upload-link" type="text" readonly value="${escapeHtml(link)}"><button class="button button-secondary" type="button" data-copy-target="#upload-link">Copy link</button></span></label>
        <div class="notice"><span class="notice-icon" aria-hidden="true">!</span><span>The secret will not be shown again. If a transfer fails, revoke or replace the link instead of reusing it.</span></div>
        <ul class="privacy-list"><li>Expires in ${hours} hours</li><li>Maximum upload ${escapeHtml(formatBytes(maxBytes))}</li><li>No operator account required for the uploader</li></ul>
        <div class="success-actions"><a class="button" href="/cases/${encodeURIComponent(request.params.caseId)}">Return to case</a></div>
      </div></section>`, { chrome: "operator", csrfToken: session.csrfToken }));
  });
  server.post<{ Params: { grantId: string } }>("/grants/:grantId/revoke", async (request, reply) => {
    if (requireCsrf(request, reply, options.sessions) === undefined) return reply;
    const result = options.application.revokeGrant(request.params.grantId);
    return result.ok ? reply.code(303).redirect("/") : reply.code(409).send(result.code);
  });
  server.get<{ Params: { caseId: string } }>("/cases/:caseId/manifest.json", async (request, reply) => {
    if (requireOperator(request, reply, options.sessions) === undefined) return reply;
    return reply.type("application/json").send(options.application.caseManifest(request.params.caseId));
  });
  server.get<{ Params: { dumpId: string } }>("/dumps/:dumpId", async (request, reply) => {
    const session = requireOperator(request, reply, options.sessions);
    if (session === undefined) return reply;
    const projection = options.application.snapshot();
    const dump = projection.dumps.find(item => item.dumpId === request.params.dumpId);
    if (dump === undefined) return reply.code(404).send("Dump not found");
    const caseItem = projection.cases.find(item => item.caseId === dump.caseId);
    const download = dump.phase === "available"
      ? `<a class="button" href="/dumps/${encodeURIComponent(dump.dumpId)}/download">Download original dump</a>`
      : `<span class="button button-secondary is-disabled" aria-disabled="true">Download unavailable</span>`;
    const audits = projection.auditEvents.filter(event => event.dumpId === dump.dumpId);
    const retention = dump.phase === "available" || dump.phase === "rejected"
      ? `<form method="post" action="/dumps/${encodeURIComponent(dump.dumpId)}/retention" class="form-stack"><input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}"><label class="field"><span class="field-label">Retain for</span><span class="inline-suffix"><input type="number" name="retentionDays" min="1" max="${MAX_RETENTION_DAYS}" value="30" required inputmode="numeric"><span>days</span></span><span class="field-hint">The purge deadline is calculated from the server clock when this form is submitted.</span></label><button class="button button-secondary" type="submit">Update retention</button></form>`
      : `<div class="notice"><span class="notice-icon" aria-hidden="true">i</span><span>Retention can be assigned after validation reaches available or rejected.</span></div>`;
    return reply.type("text/html; charset=utf-8").send(page("Dump detail", `
      <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Cases</a><span>/</span><a href="/cases/${encodeURIComponent(dump.caseId)}">${escapeHtml(caseItem?.title ?? "Case")}</a><span>/</span><span>Dump</span></nav>
      <header class="page-heading"><div><p class="eyebrow">Crash evidence</p><h1 class="mono detail-title">${escapeHtml(dump.dumpId)}</h1><p>Received for ${escapeHtml(caseItem?.title ?? dump.caseId)}</p></div><div class="heading-actions">${statusPill(dump.phase)}${download}</div></header>
      <div class="layout-grid">
        <div class="stack"><section class="panel"><header class="panel-header"><div><h2>Artifact details</h2><p>Facts recorded from the immutable original.</p></div></header><div class="panel-body"><dl class="detail-grid"><div class="detail"><dt>Lifecycle phase</dt><dd>${statusPill(dump.phase)}</dd></div><div class="detail"><dt>Memory coverage</dt><dd>${escapeHtml(dump.coverage ?? "Unclassified")}</dd></div><div class="detail"><dt>Stored size</dt><dd>${escapeHtml(formatBytes(dump.byteSize))}</dd></div><div class="detail"><dt>Purge at</dt><dd>${escapeHtml(dump.purgeAt ?? "Not scheduled")}</dd></div></dl></div></section><section class="panel"><header class="panel-header"><div><h2>Lifecycle activity</h2><p>Audited events for this dump.</p></div></header><div class="panel-body panel-body-flush">${auditTimeline(audits)}</div></section></div>
        <aside class="stack"><section class="panel panel-accent"><header class="panel-header"><div><h2>Retention</h2><p>Control when active bytes are purged.</p></div></header><div class="panel-body">${retention}</div></section><section class="panel"><div class="panel-body"><p class="eyebrow">Integrity note</p><p class="side-copy">A displayed hash identifies the received original; it does not authenticate who created the process memory.</p></div></section></aside>
      </div>`, { chrome: "operator", csrfToken: session.csrfToken, wide: true }));
  });
  server.post<{ Params: { dumpId: string } }>("/dumps/:dumpId/retention", async (request, reply) => {
    if (requireCsrf(request, reply, options.sessions) === undefined) return reply;
    const retentionDaysText = formBody(request).get("retentionDays")?.trim() ?? "";
    if (!/^[1-9][0-9]*$/.test(retentionDaysText)) return reply.code(400).send("Invalid retention period");
    const retentionDays = Number(retentionDaysText);
    if (!Number.isSafeInteger(retentionDays) || retentionDays > MAX_RETENTION_DAYS) {
      return reply.code(400).send("Invalid retention period");
    }
    const serverTime = now();
    if (!Number.isSafeInteger(serverTime) || serverTime < 0) return reply.code(503).send("Server clock unavailable");
    const purgeDate = new Date(serverTime + retentionDays * RETENTION_DAY_MS);
    if (!Number.isFinite(purgeDate.getTime())) return reply.code(503).send("Server clock unavailable");
    const purgeAt = purgeDate.toISOString();
    const result = options.application.setRetention(request.params.dumpId, purgeAt);
    return result.ok
      ? reply.code(303).redirect(`/dumps/${encodeURIComponent(request.params.dumpId)}`)
      : reply.code(409).send(result.code);
  });
  server.get("/operations/health", async (request, reply) => {
    if (requireOperator(request, reply, options.sessions) === undefined) return reply;
    const integrityErrors = options.application.operations?.().integrityErrors ?? [];
    return reply.send({
      status: integrityErrors.length === 0 ? "ok" : "degraded",
      integrityErrorCount: integrityErrors.length,
      uploads: uploadAdmission.snapshot(),
      postProcessing: options.postProcessingQueue?.snapshot() ?? { pending: 0, exhausted: 0, totalRetries: 0 },
      runtimeJobs: options.runtimeJobs?.map(job => job.snapshot()) ?? [],
    });
  });

  server.get("/operations", async (request, reply) => {
    const session = requireOperator(request, reply, options.sessions);
    if (session === undefined) return reply;
    const integrityErrors = options.application.operations?.().integrityErrors ?? [];
    const admission = uploadAdmission.snapshot();
    const processing = options.postProcessingQueue?.snapshot() ?? { pending: 0, exhausted: 0, totalRetries: 0 };
    const jobs = options.runtimeJobs?.map(job => job.snapshot()) ?? [];
    const health = integrityErrors.length === 0 ? "ok" : "degraded";
    const jobsMarkup = jobs.length === 0
      ? emptyState("No periodic jobs", "Runtime jobs are optional in this deployment.")
      : `<div class="record-list">${jobs.map(job => `<div class="record-row"><div class="record-main"><span class="record-title">${escapeHtml(job.name)}</span><div class="record-meta"><span>${job.runs} runs</span><span>${job.failures} failures</span></div></div>${statusPill(job.running ? "running" : "stopped")}</div>`).join("")}</div>`;
    return reply.type("text/html; charset=utf-8").send(page("Operations", `
      <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">Cases</a><span>/</span><span>Operations</span></nav>
      <header class="page-heading"><div><p class="eyebrow">Runtime overview</p><h1>Operations</h1><p>Local health signals without exposing customer or vault contents.</p></div><div class="heading-actions">${statusPill(health)}<a class="button button-secondary" href="/operations/health">View JSON</a></div></header>
      <section class="metric-grid" aria-label="Runtime health"><div class="metric"><span class="metric-label">Integrity</span><strong class="metric-value metric-word">${health}</strong><span class="metric-note">${integrityErrors.length} reported errors</span></div><div class="metric"><span class="metric-label">Uploads</span><strong class="metric-value">${admission.active}/${admission.capacity}</strong><span class="metric-note">Active / admitted</span></div><div class="metric"><span class="metric-label">Processing queue</span><strong class="metric-value">${processing.pending}</strong><span class="metric-note">${processing.exhausted} exhausted</span></div><div class="metric"><span class="metric-label">Retries</span><strong class="metric-value">${processing.totalRetries}</strong><span class="metric-note">Post-upload attempts</span></div></section>
      <div class="layout-grid"><section class="panel"><header class="panel-header"><div><h2>Runtime jobs</h2><p>Bounded tasks never overlap themselves.</p></div></header>${jobsMarkup}</section><aside class="panel"><header class="panel-header"><div><h2>Integrity</h2><p>SQLite consistency status.</p></div></header><div class="panel-body">${integrityErrors.length === 0 ? `<div class="health-ok"><span aria-hidden="true">✓</span><div><strong>All checks passed</strong><p>No SQLite integrity errors are currently reported.</p></div></div>` : `<div class="notice"><span class="notice-icon" aria-hidden="true">!</span><span>${integrityErrors.length} integrity errors require operator review.</span></div>`}</div></aside></div>
    `, { chrome: "operator", csrfToken: session.csrfToken, wide: true }));
  });

  server.get<{ Params: { secret: string } }>("/upload/:secret", async (request, reply) => {
    if (!validSecret(request.params.secret)) return reply.code(404).send("Upload grant unavailable");
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(page("Upload dump", `
      <section class="upload-shell"><div class="upload-card">
        <p class="eyebrow">Secure case intake</p><h1>Upload crash dump</h1><p>Your file is sent directly to this private DumpLedger instance and associated with the intended support case.</p>
        <div class="notice"><span class="notice-icon" aria-hidden="true">!</span><span>Process memory may contain secrets, personal data, and private documents. Upload only with authorization.</span></div>
        <label id="drop-zone" class="drop-zone" for="dump-file"><input id="dump-file" type="file" accept=".dmp,application/octet-stream"><span class="drop-icon" aria-hidden="true">⇧</span><span class="drop-title">Choose a minidump or drop it here</span><span class="drop-copy">Partial and full-memory Windows minidumps are accepted</span><span class="selected-file"><strong id="file-name">No file selected</strong><span id="file-size"></span></span></label>
        <div id="upload-progress" class="progress-track" role="progressbar" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><div id="upload-progress-bar" class="progress-bar"></div></div>
        <div class="upload-actions"><button id="upload-button" class="button" type="button" disabled>Upload dump</button><p id="upload-status" class="upload-status" data-tone="neutral" aria-live="polite">Select a file to continue</p></div>
        <ul class="privacy-list"><li>One-time case-bound link</li><li>SHA-256 calculated during transfer</li><li>Original bytes remain immutable</li></ul>
      </div></section><script src="/assets/upload.js" defer></script>`, { chrome: "public", bodyClass: "upload-page" }));
  });
  server.post<{ Params: { secret: string } }>("/upload/:secret", async (request, reply) => {
    if (!uploadGrantRateLimiter.take(request.ip)) return reply.header("Retry-After", "60").code(429).send({ error: "rate_limited" });
    if (!validSecret(request.params.secret)) return reply.code(404).send({ error: "grant_invalid" });
    const contentLengthText = request.headers["content-length"];
    let contentLength: bigint | undefined;
    if (contentLengthText !== undefined) {
      try { contentLength = BigInt(contentLengthText); } catch { return reply.code(400).send({ error: "upload_incomplete" }); }
      if (contentLength < 0n) return reply.code(400).send({ error: "upload_incomplete" });
    }
    const admission = uploadAdmission.tryAcquire();
    if (admission === undefined) return reply.header("Retry-After", "5").code(503).send({ error: "upload_busy" });
    try {
      const receipt = await upload.receive({
        grantSecret: request.params.secret,
        originalName: headerText(request.headers["x-dump-filename"], "upload.dmp"),
        ...(contentLength === undefined ? {} : { contentLength }),
        bytes: request.body as NodeJS.ReadableStream,
      });
      let phase: "sealed" | "available" | "rejected" = "sealed";
      if (options.uploadPostProcessor !== undefined) {
        try {
          phase = options.uploadPostProcessor.process(receipt.dumpId);
        } catch {
          const queued = options.postProcessingQueue?.enqueue(receipt.dumpId) ?? false;
          return reply.code(202).send({
            dumpId: receipt.dumpId,
            byteSize: receipt.byteSize.toString(),
            sha256: receipt.sha256,
            processing: queued ? "retry-queued" : "recovery-required",
          });
        }
      }
      return reply.code(201).header("Cache-Control", "no-store").send({ dumpId: receipt.dumpId, byteSize: receipt.byteSize.toString(), sha256: receipt.sha256, phase });
    } catch (error) {
      const code = error instanceof IntakeError ? error.code : "upload_incomplete";
      return reply.code(code === "upload_too_large" ? 413 : code === "grant_invalid" ? 404 : 503).send({ error: code });
    } finally {
      admission.release();
    }
  });

  server.get<{ Params: { dumpId: string } }>("/dumps/:dumpId/download", async (request, reply) => {
    if (requireOperator(request, reply, options.sessions) === undefined) return reply;
    const download = options.application.openDownload(request.params.dumpId);
    if (download === undefined || download.phase !== "available") return reply.code(404).send("Dump not available");
    const safeName = /^[A-Za-z0-9_-]{1,100}$/.test(request.params.dumpId) ? request.params.dumpId : "dump";
    return reply
      .header("Content-Disposition", `attachment; filename="${safeName}.dmp"`)
      .header("Content-Length", download.byteSize.toString())
      .type("application/octet-stream")
      .send(download.bytes);
  });

  return server;
}
