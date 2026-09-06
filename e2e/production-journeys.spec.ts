/**
 * Real-browser journeys against the PRODUCTION build (design sections 12 and
 * 13). global-setup.ts has already launched `node dist/src/main.js` on an
 * ephemeral 127.0.0.1 port with a temp data dir and a generated operator
 * credential; this spec reads that state, drives the compiled React app, and
 * exercises one complete intake path end to end:
 *
 *   (a) operator login -> dashboard -> create customer -> create case ->
 *       transition the workflow -> issue a grant -> read the fragment link,
 *   (b) public upload of the synthetic minidump through the fragment URL with
 *       real byte streaming to a terminal state,
 *   (c) grant replay fails closed with the neutral unavailable state,
 *   (d) deep link + reload restores the operator session,
 *   (e) the original dump downloads and its bytes match what was uploaded.
 *
 * The grant fragment is read once and never printed or logged.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { syntheticMinidump } from "../dist/test/fixtures/minidump/synthetic-minidump.js";

interface ServerState {
  readonly baseURL: string;
  readonly port: number;
  readonly dataDir: string;
  readonly pid: number;
  readonly password: string;
}

const state = JSON.parse(readFileSync(join(tmpdir(), "dump-ledger-e2e-state.json"), "utf8")) as ServerState;

test.use({ baseURL: state.baseURL });

test.describe.configure({ mode: "serial" });

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

let operatorContext: BrowserContext | undefined;
let operatorPage: Page | undefined;
let caseId = "";
let shareUrl = "";
let uploadedDumpId = "";
const minidumpBytes = syntheticMinidump({ memoryListSizes: [8] });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  operatorContext = await browser.newContext();
  operatorPage = await operatorContext.newPage();
});

test.afterAll(async () => {
  await operatorContext?.close();
});

test("(a) operator login, dashboard, customer, case, workflow, and grant issue", async () => {
  const page = operatorPage as Page;

  // An anonymous operator hitting an operator route lands on /login.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Operator sign in" })).toBeVisible();

  await page.getByLabel("Operator password").fill(state.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // Create a customer.
  await page.getByLabel("Display name").fill("Acme E2E");
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  await expect(page.getByText("Added customer Acme E2E.")).toBeVisible();

  // Create a case under that customer.
  await page.getByLabel("New case").fill("Renderer crash on startup");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const openCase = page.getByRole("link", { name: "Open case", exact: true });
  await expect(openCase).toBeVisible();
  await openCase.click();

  await expect(page).toHaveURL(/\/cases\/[^/]+$/);
  const path = new URL(page.url()).pathname;
  caseId = path.split("/").pop() ?? "";
  expect(caseId).not.toBe("");
  await expect(page.getByRole("heading", { name: "Case detail" })).toBeVisible();

  // Walk the case workflow with the server-authoritative controls.
  const statusPill = (label: string) => page.locator("span.status").getByText(label, { exact: true });

  await expect(statusPill("New")).toBeVisible();
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(statusPill("Investigating")).toBeVisible();

  await page.getByRole("button", { name: "Wait for customer", exact: true }).click();
  await expect(statusPill("Waiting for customer")).toBeVisible();

  await page.getByRole("button", { name: "Resume investigation", exact: true }).click();
  await expect(statusPill("Investigating")).toBeVisible();

  await page.getByRole("button", { name: "Resolve case", exact: true }).click();
  await expect(statusPill("Resolved")).toBeVisible();

  // Issue a one-time grant and read its shareable fragment URL.
  await page.getByRole("button", { name: "Generate secure link", exact: true }).click();
  const shareInput = page.getByLabel("Shareable upload URL", { exact: true });
  await expect(shareInput).toBeVisible();
  shareUrl = await shareInput.inputValue();
  expect(shareUrl.startsWith(`${state.baseURL}/upload#grant=`)).toBe(true);
});

test("(b) public fragment upload streams the synthetic minidump to a terminal state", async ({ browser }: { browser: Browser }) => {
  expect(shareUrl).not.toBe("");
  const publicContext = await browser.newContext();
  const page = await publicContext.newPage();
  try {
    await page.goto(shareUrl);
    await expect(page.getByText("One-time intake link", { exact: true })).toBeVisible();
    await page.getByLabel("Choose a minidump file").setInputFiles({
      name: "renderer.dmp",
      mimeType: "application/octet-stream",
      buffer: minidumpBytes,
    });
    await page.getByRole("button", { name: "Upload dump", exact: true }).click();

    // Terminal success state (phase "available" => "Upload complete").
    const result = page.locator(".upload-result");
    await expect(result.getByText("Upload complete", { exact: true })).toBeVisible();

    const text = await result.innerText();
    const dumpIdMatch = /Dump ID: (\S+)/.exec(text);
    expect(dumpIdMatch).not.toBeNull();
    uploadedDumpId = dumpIdMatch?.[1] ?? "";
    expect(uploadedDumpId).not.toBe("");
    expect(text).toContain(`SHA-256: ${sha256Hex(minidumpBytes)}`);

    // The one-time secret was scrubbed from the address bar.
    expect(page.url()).not.toContain("grant=");
  } finally {
    await publicContext.close();
  }
});

test("(c) grant replay fails closed with the neutral unavailable state", async ({ browser }: { browser: Browser }) => {
  expect(shareUrl).not.toBe("");
  const replayContext = await browser.newContext();
  const page = await replayContext.newPage();
  try {
    await page.goto(shareUrl);
    await expect(page.getByText("One-time intake link", { exact: true })).toBeVisible();
    await page.getByLabel("Choose a minidump file").setInputFiles({
      name: "renderer.dmp",
      mimeType: "application/octet-stream",
      buffer: minidumpBytes,
    });
    await page.getByRole("button", { name: "Upload dump", exact: true }).click();
    await expect(page.getByText("This intake link is not available", { exact: true })).toBeVisible();
  } finally {
    await replayContext.close();
  }
});

test("(d) deep link and reload restore the operator session", async () => {
  const page = operatorPage as Page;
  expect(caseId).not.toBe("");
  await page.goto(`/cases/${encodeURIComponent(caseId)}`);
  await expect(page.getByRole("heading", { name: "Case detail" })).toBeVisible();
  await expect(page.getByText("Renderer crash on startup", { exact: true })).toBeVisible();

  // A hard reload re-bootstraps the session from GET /api/v1/session and
  // renders the same operator page without bouncing to /login.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Case detail" })).toBeVisible();
  await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/cases\/[^/]+$/);
});

test("(e) the original dump downloads and its bytes match the upload", async () => {
  const page = operatorPage as Page;
  expect(uploadedDumpId).not.toBe("");
  await page.goto(`/dumps/${encodeURIComponent(uploadedDumpId)}`);
  await expect(page.getByRole("heading", { name: "Dump detail" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download original dump", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${uploadedDumpId}.dmp`);

  const stream = await download.createReadStream();
  const downloadedBytes = await collectStream(stream);
  expect(downloadedBytes.equals(minidumpBytes)).toBe(true);
  expect(sha256Hex(downloadedBytes)).toBe(sha256Hex(minidumpBytes));
});
