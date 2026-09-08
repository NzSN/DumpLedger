/**
 * Real-browser journeys for the export/import transfer surface (import/export
 * design, milestone IE3) against the PRODUCTION build. global-setup.ts has
 * already launched instance A (`node dist/src/main.js`, ephemeral port, temp
 * data dir, generated operator credential); this spec reads that state and
 * drives the compiled React app.
 *
 *   Journey 1 — round trip across two instances:
 *     (a) operator login -> customer -> case -> upload grant -> public
 *         fragment upload of the synthetic minidump to the available phase,
 *     (b) create an export bundle on the operations page, wait for sealed,
 *         download the tar through the UI link, and save it to a temp path,
 *     (c) spawn instance B (own temp data dir, own ephemeral port, SAME grant
 *         key and operator password as A) and import the saved bundle through
 *         B's operations UI until progress reaches finished with the expected
 *         counts,
 *     (d) on B the case exists, the dump is available, and its download is
 *         byte-identical to what was uploaded to A.
 *
 *   Journey 2 — tampered bundle fails closed:
 *     (e) flip one byte inside the dump data region of the tar (ustar headers,
 *         manifest, and ledger keep their exact bytes), import into a FRESH
 *         instance C (import requires an empty ledger and B is populated by
 *         then), and assert the import finishes with the tampered dump
 *         rejected — never available — and its download refused with the JSON
 *         error envelope.
 *
 * B and C are child processes spawned by this spec; afterAll stops them
 * (SIGTERM, then SIGKILL) and removes every temp dir the journeys created.
 * The grant fragment is read once and never printed or logged.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { hashOperatorPassword } from "../dist/src/auth/sessions.js";
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

/**
 * The grant key formula from e2e/global-setup.ts. Instances B and C must use
 * the SAME grant key as A so the bundle's grant-key fingerprint matches and
 * imported outstanding grants stay honored rather than force-revoked.
 */
const GRANT_KEY = Buffer.alloc(32, 0x5a).toString("base64url");

const TAR_BLOCK = 512;

interface InstanceHandle {
  readonly baseURL: string;
  readonly dataDir: string;
  readonly child: ChildProcess;
}

/** Location of one regular-file entry inside a ustar tar buffer. */
interface TarEntryLocation {
  readonly name: string;
  readonly size: number;
  readonly dataOffset: number;
}

interface BundleManifestDump {
  readonly dumpId: string;
  readonly phase: string;
  readonly entry: string | null;
}

interface BundleManifest {
  readonly dumps: readonly BundleManifestDump[];
  readonly skipped: readonly unknown[];
}

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

/** Replicated from e2e/global-setup.ts: allocate an ephemeral localhost port. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not allocate an ephemeral port")));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Minimal read-only ustar walk for locating entries inside a downloaded
 * bundle: 512-byte headers, octal (or GNU base-256) size at offset 124,
 * data padded to whole blocks, two zero blocks end the archive. The writer
 * (src/transfer/tar.ts) never emits prefix or long-name entries, so names
 * always fit the 100-byte name field.
 */
function listTarEntries(bundle: Buffer): TarEntryLocation[] {
  const entries: TarEntryLocation[] = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= bundle.length) {
    const header = bundle.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break; // end marker
    let nameEnd = header.indexOf(0);
    if (nameEnd === -1 || nameEnd > 100) nameEnd = 100;
    const name = header.toString("utf8", 0, nameEnd);
    const sizeField = header.subarray(124, 136);
    // NB: cast to a plain number first — `x as number & 0x80` would parse as
    // `x as (number & 0x80)` and erase the mask at runtime.
    const firstSizeByte = sizeField[0] as number;
    let size = 0;
    if ((firstSizeByte & 0x80) !== 0) {
      for (let index = 1; index < 12; index += 1) size = size * 256 + (sizeField[index] as number);
    } else {
      for (const byte of sizeField) {
        if (byte < 0x30 || byte > 0x37) break; // digits, then NUL/space padding
        size = size * 8 + (byte - 0x30);
      }
    }
    const dataOffset = offset + TAR_BLOCK;
    entries.push({ name, size, dataOffset });
    offset = dataOffset + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return entries;
}

function readEntryBytes(bundle: Buffer, entry: TarEntryLocation): Buffer {
  return bundle.subarray(entry.dataOffset, entry.dataOffset + entry.size);
}

function readManifest(bundle: Buffer): BundleManifest {
  const entry = listTarEntries(bundle).find((candidate) => candidate.name === "manifest.json");
  if (entry === undefined) throw new Error("bundle carries no manifest.json entry");
  return JSON.parse(readEntryBytes(bundle, entry).toString("utf8")) as BundleManifest;
}

/**
 * Returns a copy of the bundle with exactly one byte flipped in the middle of
 * the named entry's data region. Headers are never touched, so the tar stays
 * structurally valid and the manifest and ledger keep their exact bytes; only
 * the dump payload changes, which the importer's SHA-256 verification must
 * catch.
 */
function tamperDumpEntry(bundle: Buffer, entryName: string): Buffer {
  const tampered = Buffer.from(bundle);
  const entry = listTarEntries(tampered).find((candidate) => candidate.name === entryName);
  if (entry === undefined) throw new Error(`bundle carries no entry named ${entryName}`);
  if (entry.size === 0) throw new Error(`bundle entry ${entryName} is empty; nothing safe to flip`);
  const flipAt = entry.dataOffset + Math.floor(entry.size / 2);
  tampered[flipAt] = (tampered[flipAt] as number) ^ 0xff;
  return tampered;
}

/**
 * Spawns another production server (same entry point and env shape as
 * e2e/global-setup.ts) with its own temp data dir and ephemeral port, and
 * waits until /health answers. The operator password hash is regenerated
 * from the same plaintext the global setup state records.
 */
async function startInstance(tag: string): Promise<InstanceHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), `dump-ledger-e2e-${tag}-data-`));
  const port = await freePort();
  const passwordHash = await hashOperatorPassword(state.password);
  const serverEntry = join(process.cwd(), "dist", "src", "main.js");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DUMP_LEDGER_DATA_DIR: dataDir,
      DUMP_LEDGER_GRANT_KEY: GRANT_KEY,
      DUMP_LEDGER_OPERATOR_PASSWORD_HASH: passwordHash,
      DUMP_LEDGER_HOST: "127.0.0.1",
      DUMP_LEDGER_PORT: String(port),
      DUMP_LEDGER_HTTPS: "false",
      DUMP_LEDGER_RETENTION_INTERVAL_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk));

  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) {
        up = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  if (!up) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    const logTail = Buffer.concat(logs).toString("utf8").slice(-4000);
    throw new Error(`instance ${tag} failed to start on port ${port}:\n${logTail}`);
  }

  return { baseURL, dataDir, child };
}

/** Stops an instance child (SIGTERM, then SIGKILL) and removes its data dir. */
async function stopInstance(handle: InstanceHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  if (handle.child.exitCode === null) {
    try {
      handle.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    try {
      handle.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(handle.dataDir, { recursive: true, force: true });
}

/** Signs the operator in through the login page of the given page's instance. */
async function signInAsOperator(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Operator sign in" })).toBeVisible();
  await page.getByLabel("Operator password").fill(state.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

/** Runs the operations-page import form and waits for the finished summary. */
async function importBundleThroughUi(page: Page, bundlePath: string, expectedSummary: string): Promise<void> {
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  const transferSection = page.locator('section[aria-label="Export / Import"]');
  await transferSection.getByLabel("Bundle path on the server").fill(bundlePath);
  await transferSection
    .getByLabel("I understand import requires an empty ledger and may revoke outstanding upload grants.")
    .check();
  await transferSection.getByRole("button", { name: "Start import", exact: true }).click();
  await expect(transferSection.getByText(expectedSummary, { exact: true })).toBeVisible();
}

let operatorContext: BrowserContext | undefined;
let operatorPage: Page | undefined;
let contextB: BrowserContext | undefined;
let pageB: Page | undefined;
let contextC: BrowserContext | undefined;
let instanceB: InstanceHandle | undefined;
let instanceC: InstanceHandle | undefined;
let caseId = "";
let shareUrl = "";
let uploadedDumpId = "";
let workDir = "";
let bundlePath = "";
let bundleManifest: BundleManifest | undefined;
const minidumpBytes = syntheticMinidump({ memoryListSizes: [8] });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  operatorContext = await browser.newContext();
  operatorPage = await operatorContext.newPage();
  workDir = mkdtempSync(join(tmpdir(), "dump-ledger-e2e-transfer-"));
});

test.afterAll(async () => {
  await operatorContext?.close();
  await contextB?.close();
  await contextC?.close();
  await stopInstance(instanceB);
  await stopInstance(instanceC);
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

test("journey 1 (a) operator seeds instance A: customer, case, grant, and an upload that reaches available", async ({ browser }: { browser: Browser }) => {
  const page = operatorPage as Page;
  await signInAsOperator(page);

  // Create a customer, then a case under it. With two specs sharing instance
  // A there may be several customer cards, so scope to ours.
  await page.getByLabel("Display name").fill("Transfer E2E");
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  await expect(page.getByText("Added customer Transfer E2E.")).toBeVisible();

  const card = page.locator(".customer-card", { hasText: "Transfer E2E" });
  await card.getByLabel("New case").fill("Export/import round trip");
  await card.getByRole("button", { name: "Create", exact: true }).click();
  const openCase = card.getByRole("link", { name: "Open case", exact: true });
  await expect(openCase).toBeVisible();
  await openCase.click();

  await expect(page).toHaveURL(/\/cases\/[^/]+$/);
  caseId = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(caseId).not.toBe("");
  await expect(page.getByRole("heading", { name: "Case detail" })).toBeVisible();

  // Issue a one-time grant and read its shareable fragment URL.
  await page.getByRole("button", { name: "Generate secure link", exact: true }).click();
  const shareInput = page.getByLabel("Shareable upload URL", { exact: true });
  await expect(shareInput).toBeVisible();
  shareUrl = await shareInput.inputValue();
  expect(shareUrl.startsWith(`${state.baseURL}/upload#grant=`)).toBe(true);

  // Public upload through the fragment link (same approach as the intake
  // journey): the terminal "Upload complete" state means phase available.
  expect(shareUrl).not.toBe("");
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  try {
    await publicPage.goto(shareUrl);
    await expect(publicPage.getByText("One-time intake link", { exact: true })).toBeVisible();
    await publicPage.getByLabel("Choose a minidump file").setInputFiles({
      name: "round-trip.dmp",
      mimeType: "application/octet-stream",
      buffer: minidumpBytes,
    });
    await publicPage.getByRole("button", { name: "Upload dump", exact: true }).click();
    const result = publicPage.locator(".upload-result");
    await expect(result.getByText("Upload complete", { exact: true })).toBeVisible();
    const text = await result.innerText();
    const dumpIdMatch = /Dump ID: (\S+)/.exec(text);
    expect(dumpIdMatch).not.toBeNull();
    uploadedDumpId = dumpIdMatch?.[1] ?? "";
    expect(uploadedDumpId).not.toBe("");
    expect(text).toContain(`SHA-256: ${sha256Hex(minidumpBytes)}`);
  } finally {
    await publicContext.close();
  }

  // Belt and braces before exporting: the dump page shows Available.
  await page.goto(`/dumps/${encodeURIComponent(uploadedDumpId)}`);
  await expect(page.getByRole("heading", { name: "Dump detail" })).toBeVisible();
  await expect(page.locator("span.status").getByText("Available", { exact: true })).toBeVisible();
});

test("journey 1 (b) the export bundle seals on the operations page and downloads as a tar", async () => {
  const page = operatorPage as Page;
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  const transferSection = page.locator('section[aria-label="Export / Import"]');

  await transferSection.getByRole("button", { name: "Create export bundle", exact: true }).click();
  await expect(transferSection.locator("span.status").getByText("Sealed", { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await transferSection.getByRole("link", { name: "Download bundle", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^dump-ledger-export-export_[0-9a-f]+\.tar$/);

  bundlePath = join(workDir, "instance-a-bundle.tar");
  await download.saveAs(bundlePath);

  // The manifest inside the downloaded tar is the source of truth for the
  // expected import counts: every dump on A is available, none was skipped.
  const bundleBytes = readFileSync(bundlePath);
  bundleManifest = readManifest(bundleBytes);
  expect(bundleManifest.skipped).toHaveLength(0);
  expect(bundleManifest.dumps.length).toBeGreaterThanOrEqual(1);
  expect(bundleManifest.dumps.every((dump) => dump.phase === "available")).toBe(true);
  const mine = bundleManifest.dumps.find((dump) => dump.dumpId === uploadedDumpId);
  expect(mine?.phase).toBe("available");
  expect(mine?.entry).toBe(`vault/${uploadedDumpId}/original.dmp`);
});

test("journey 1 (c) fresh instance B imports the downloaded bundle through its UI", async ({ browser }: { browser: Browser }) => {
  expect(bundlePath).not.toBe("");
  const manifest = bundleManifest as BundleManifest;
  const expectedCount = manifest.dumps.length;

  instanceB = await startInstance("instance-b");
  contextB = await browser.newContext({ baseURL: instanceB.baseURL });
  pageB = await contextB.newPage();
  await signInAsOperator(pageB);
  await importBundleThroughUi(
    pageB,
    bundlePath,
    `Import finished: ${expectedCount} imported, 0 rejected, 0 skipped (${expectedCount} verified).`,
  );
});

test("journey 1 (d) instance B serves the imported case and a byte-identical dump", async () => {
  const page = pageB as Page;
  expect(caseId).not.toBe("");
  expect(uploadedDumpId).not.toBe("");

  // The imported case exists with the dump listed as available.
  await page.goto(`/cases/${encodeURIComponent(caseId)}`);
  await expect(page.getByRole("heading", { name: "Case detail" })).toBeVisible();
  await expect(page.getByText("Export/import round trip", { exact: true })).toBeVisible();
  const dumpRow = page.getByRole("link", { name: new RegExp(uploadedDumpId) });
  await expect(dumpRow).toBeVisible();
  await expect(dumpRow.locator("span.status")).toHaveText("Available");

  // Downloading the dump from B yields exactly the bytes uploaded to A.
  await page.goto(`/dumps/${encodeURIComponent(uploadedDumpId)}`);
  await expect(page.getByRole("heading", { name: "Dump detail" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download original dump", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${uploadedDumpId}.dmp`);
  const downloadedBytes = await collectStream((await download.createReadStream()) as NodeJS.ReadableStream);
  expect(downloadedBytes.equals(minidumpBytes)).toBe(true);
  expect(sha256Hex(downloadedBytes)).toBe(sha256Hex(minidumpBytes));
});

test("journey 2 a byte-flipped bundle imports into fresh instance C with the dump rejected and its download refused", async ({ browser }: { browser: Browser }) => {
  expect(bundlePath).not.toBe("");
  const manifest = bundleManifest as BundleManifest;
  const mine = manifest.dumps.find((dump) => dump.dumpId === uploadedDumpId);
  expect(mine?.entry).toBe(`vault/${uploadedDumpId}/original.dmp`);
  const entryName = mine?.entry as string;

  // Flip one byte inside the dump's tar data region; prove the rest of the
  // archive — headers, manifest, ledger, other dumps — is byte-identical.
  const cleanBytes = readFileSync(bundlePath);
  const tamperedBytes = tamperDumpEntry(cleanBytes, entryName);
  expect(tamperedBytes.length).toBe(cleanBytes.length);
  let diffCount = 0;
  for (let index = 0; index < cleanBytes.length; index += 1) {
    if (cleanBytes[index] !== tamperedBytes[index]) diffCount += 1;
  }
  expect(diffCount).toBe(1);
  const afterEntries = listTarEntries(tamperedBytes);
  expect(afterEntries.map((entry) => entry.name)).toEqual(listTarEntries(cleanBytes).map((entry) => entry.name));
  const manifestBefore = readManifest(cleanBytes);
  const manifestAfter = readManifest(tamperedBytes);
  expect(JSON.stringify(manifestAfter)).toBe(JSON.stringify(manifestBefore));

  const tamperedPath = join(workDir, "tampered-bundle.tar");
  writeFileSync(tamperedPath, tamperedBytes);

  // Instance C: import requires an empty ledger, and B is populated by now.
  instanceC = await startInstance("instance-c");
  contextC = await browser.newContext({ baseURL: instanceC.baseURL });
  const pageC = await contextC.newPage();
  await signInAsOperator(pageC);
  const expectedCount = manifest.dumps.length;
  await importBundleThroughUi(
    pageC,
    tamperedPath,
    `Import finished: ${expectedCount - 1} imported, 1 rejected, 0 skipped (${expectedCount - 1} verified).`,
  );

  // The tampered dump is present on C but rejected — never available — and
  // the dump page offers no download link for it.
  await pageC.goto(`/dumps/${encodeURIComponent(uploadedDumpId)}`);
  await expect(pageC.getByRole("heading", { name: "Dump detail" })).toBeVisible();
  await expect(pageC.locator("span.status").getByText("Rejected", { exact: true })).toBeVisible();
  await expect(pageC.getByRole("link", { name: "Download original dump" })).toHaveCount(0);

  // The download route itself refuses with the JSON error envelope.
  const response = await contextC.request.get(
    `${instanceC.baseURL}/api/v1/dumps/${encodeURIComponent(uploadedDumpId)}/content`,
  );
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");
  const body = (await response.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
  expect(body.error?.code).toBe("not_found");
  expect(typeof body.error?.message).toBe("string");
});
