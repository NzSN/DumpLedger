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

const SYMBOL_GUID_BYTES = Buffer.from([
  0x67, 0x45, 0x23, 0x01, 0xab, 0x89, 0xef, 0xcd,
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
]);
const SYMBOL_DEBUG_ID = "0123456789ABCDEF0123456789ABCDEF1";
const SYMBOL_DEBUG_FILE = "electron.pdb";

/** Minimal synthetic MSF 7.0 container whose stream 1 is one RSDS record. */
function syntheticPdb(pdbPath = `C:\\build\\${SYMBOL_DEBUG_FILE}`, age = 1): Buffer {
  const blockSize = 4096;
  const rsds = Buffer.alloc(4 + 16 + 4 + pdbPath.length + 1);
  rsds.write("RSDS", 0, "latin1");
  SYMBOL_GUID_BYTES.copy(rsds, 4);
  rsds.writeUInt32LE(age, 20);
  rsds.write(pdbPath, 24, "latin1");
  const streams = [Buffer.alloc(0), rsds];
  const directory = Buffer.alloc(4 + streams.length * 4);
  directory.writeUInt32LE(streams.length, 0);
  streams.forEach((stream, index) => directory.writeUInt32LE(stream.length, 4 + index * 4));
  const streamStartBlocks: number[] = [];
  let nextBlock = 1;
  for (const stream of streams) {
    streamStartBlocks.push(nextBlock);
    nextBlock += Math.ceil(stream.length / blockSize);
  }
  const directoryStartBlock = nextBlock;
  const blockMapStartBlock = directoryStartBlock + 1;
  const numBlocks = blockMapStartBlock + 1;
  const bytes = Buffer.alloc(numBlocks * blockSize);
  bytes.write("Microsoft C/C++ MSF 7.00\r\n\u001aDS", 0, "latin1");
  bytes.writeUInt32LE(blockSize, 32);
  bytes.writeUInt32LE(1, 36);
  bytes.writeUInt32LE(numBlocks, 40);
  bytes.writeUInt32LE(directory.length, 44);
  bytes.writeUInt32LE(0, 48);
  bytes.writeUInt32LE(blockMapStartBlock, 52);
  streams.forEach((stream, index) => stream.copy(bytes, streamStartBlocks[index]! * blockSize));
  directory.copy(bytes, directoryStartBlock * blockSize);
  bytes.writeUInt32LE(directoryStartBlock, blockMapStartBlock * blockSize);
  bytes.writeUInt32LE(blockMapStartBlock, blockMapStartBlock * blockSize + 4);
  return bytes;
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

  // Create a case under that customer. The dashboard renders one "New case"
  // form per customer card, and other specs sharing this server may have
  // added their own cards, so scope to the Acme card.
  const acmeCard = page.locator(".customer-card", { hasText: "Acme E2E" });
  await acmeCard.getByLabel("New case").fill("Renderer crash on startup");
  await acmeCard.getByRole("button", { name: "Create", exact: true }).click();
  const openCase = acmeCard.getByRole("link", { name: "Open case", exact: true });
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

test("(a2) the individual customer panel lists its cases and links through", async () => {
  const page = operatorPage as Page;
  await page.goto("/");
  const acmeCard = page.locator(".customer-card", { hasText: "Acme E2E" });
  await acmeCard.getByRole("link", { name: "Open customer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Acme E2E" })).toBeVisible();
  const caseRow = page.getByRole("link", { name: /Renderer crash on startup/ });
  await expect(caseRow).toBeVisible();
  await caseRow.click();
  await expect(page.getByRole("heading", { name: "Case detail" })).toBeVisible();
  await expect(page.getByText("Renderer crash on startup", { exact: true })).toBeVisible();
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

test("(c) grant replay earns the distinct exhausted state (batch design, decision 3)", async ({ browser }: { browser: Browser }) => {
  expect(shareUrl).not.toBe("");
  const replayContext = await browser.newContext();
  const page = await replayContext.newPage();
  try {
    await page.goto(shareUrl);
    // The quota answer reports zero remaining slots, so the page renders the
    // distinct exhaustion outcome before a byte is offered.
    await expect(page.getByText("This intake link has no uploads left", { exact: true })).toBeVisible();
  } finally {
    await replayContext.close();
  }
});

test("(b2) one batch grant uploads three dumps through a single link", async ({ browser }: { browser: Browser }) => {
  const page = operatorPage as Page;
  expect(caseId).not.toBe("");
  await page.goto(`/cases/${encodeURIComponent(caseId)}`);
  await expect(page.getByRole("heading", { name: "Case detail" })).toBeVisible();
  await page.getByLabel("Dumps allowed").fill("3");
  await page.getByRole("button", { name: "Generate secure link", exact: true }).click();
  const shareInput = page.getByLabel("Shareable upload URL", { exact: true });
  await expect(shareInput).toBeVisible();
  const batchUrl = await shareInput.inputValue();
  expect(batchUrl.startsWith(`${state.baseURL}/upload#grant=`)).toBe(true);

  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  try {
    await publicPage.goto(batchUrl);
    await expect(publicPage.getByText("Case intake link", { exact: true })).toBeVisible();
    await publicPage.getByLabel("Choose minidump files").setInputFiles([
      { name: "one.dmp", mimeType: "application/octet-stream", buffer: minidumpBytes },
      { name: "two.dmp", mimeType: "application/octet-stream", buffer: minidumpBytes },
      { name: "three.dmp", mimeType: "application/octet-stream", buffer: minidumpBytes },
    ]);
    await expect(publicPage.getByText("3 files selected", { exact: true })).toBeVisible();
    await publicPage.getByRole("button", { name: "Upload 3 dumps", exact: true }).click();

    // Sequential streaming settles in the batch summary with per-file outcomes.
    const result = publicPage.locator(".upload-result");
    await expect(result.getByText("Batch upload complete", { exact: true })).toBeVisible();
    await expect(result).toContainText("3 of 3 files uploaded");
    const text = await result.innerText();
    expect(text).toContain("one.dmp");
    expect(text).toContain("two.dmp");
    expect(text).toContain("three.dmp");
    expect(text.match(/Dump ID: \S+/g)?.length).toBe(3);
  } finally {
    await publicContext.close();
  }

  // A fresh visit to the now-exhausted link renders the distinct terminal state.
  const revisit = await browser.newContext();
  const revisitPage = await revisit.newPage();
  try {
    await revisitPage.goto(batchUrl);
    await expect(revisitPage.getByText("This intake link has no uploads left", { exact: true })).toBeVisible();
  } finally {
    await revisit.close();
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

test("(f) operator ingests a PDB on the Symbols page and the symsrv route serves it", async () => {
  const page = operatorPage as Page;
  const pdb = syntheticPdb();
  await page.goto("/symbols");
  await expect(page.getByRole("heading", { name: "Symbols" })).toBeVisible();

  // Ingest through the drop-zone input; the per-file row shows the parsed identity.
  await page.getByLabel("Choose PDB files", { exact: true }).setInputFiles({
    name: SYMBOL_DEBUG_FILE,
    mimeType: "application/octet-stream",
    buffer: pdb,
  });
  await expect(page.getByText(/electron\.pdb .*registered/).first()).toBeVisible();
  await expect(page.getByText(SYMBOL_DEBUG_ID.slice(0, 4), { exact: false }).first()).toBeVisible();

  // The symsrv route streams byte-identical content with immutable caching.
  const fetched = await page.request.get(`/symbols/${SYMBOL_DEBUG_FILE}/${SYMBOL_DEBUG_ID}/${SYMBOL_DEBUG_FILE}`);
  expect(fetched.status()).toBe(200);
  expect(fetched.headers()["cache-control"]).toContain("immutable");
  expect(Buffer.from(await fetched.body()).equals(pdb)).toBe(true);

  // Purge via the row + confirmation, then the route 404s.
  await page.getByRole("button", { name: "Purge", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Purge/ }).click();
  await expect(page.getByRole("heading", { name: "Symbols" })).toBeVisible();
  const gone = await page.request.get(`/symbols/${SYMBOL_DEBUG_FILE}/${SYMBOL_DEBUG_ID}/${SYMBOL_DEBUG_FILE}`);
  expect(gone.status()).toBe(404);
});
