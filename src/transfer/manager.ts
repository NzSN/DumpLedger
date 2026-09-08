/**
 * Transfer job registry for the operations surface: runs at most one export
 * or import at a time (a second attempt fails with invalid_transition),
 * tracks status/counts/error per job for the HTTP layer, and reconciles the
 * exports directory at startup — sealed bundles are listed, directories
 * without a sealed bundle are leftover .part work areas and are removed.
 */

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExportSummary, ImportStatus } from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../domain/errors.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { Vault } from "../vault/vault.js";
import { exportBundle } from "./export.js";
import { importBundle } from "./import.js";

const JOB_ID_PATTERN = /^(export|import)_[0-9a-f]{32}$/;
const BUNDLE_FINAL_NAME = "bundle.tar";
const MAX_ERROR_LENGTH = 2000;

/** Import job view tracked for the HTTP layer; matches ImportProgressResponse. */
export interface ImportJob {
  readonly importId: string;
  readonly status: ImportStatus;
  readonly verified: number;
  readonly imported: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly error: string | null;
}

export interface TransferManagerOptions {
  readonly engine: DumpLedgerEngine;
  readonly vault: Vault;
  readonly exportsDir: string;
  /** Passed through to the manifest generator block; informational only. */
  readonly generatorVersion?: string;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 3)}...` : message;
}

function assertRealDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DumpLedgerError("storage_unavailable", "exports directory is not a real directory");
}

export class TransferManager {
  readonly #engine: DumpLedgerEngine;
  readonly #vault: Vault;
  readonly #exportsDir: string;
  readonly #generatorVersion: string | undefined;
  readonly #exports = new Map<string, ExportSummary>();
  readonly #imports = new Map<string, ImportJob>();
  #active: string | null = null;

  constructor(options: TransferManagerOptions) {
    this.#engine = options.engine;
    this.#vault = options.vault;
    this.#exportsDir = resolve(options.exportsDir);
    this.#generatorVersion = options.generatorVersion;
    mkdirSync(this.#exportsDir, { recursive: true, mode: 0o700 });
    assertRealDirectory(this.#exportsDir);
    this.#scanExportsDir();
  }

  /** Sealed bundles on disk are listed; directories without a sealed bundle are removed. */
  #scanExportsDir(): void {
    for (const entry of readdirSync(this.#exportsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (/^import-/.test(entry.name)) {
        rmSync(join(this.#exportsDir, entry.name), { recursive: true, force: true });
        continue;
      }
      if (!JOB_ID_PATTERN.test(entry.name) || !entry.name.startsWith("export_")) continue;
      const directory = join(this.#exportsDir, entry.name);
      const finalPath = join(directory, BUNDLE_FINAL_NAME);
      let sealed = false;
      try {
        const info = lstatSync(finalPath, { bigint: true });
        if (info.isFile()) {
          sealed = true;
          this.#exports.set(entry.name, {
            exportId: entry.name,
            status: "sealed",
            createdAt: new Date(Math.floor(Number(info.mtimeMs))).toISOString(),
            byteSize: info.size.toString(),
            error: null,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!sealed) rmSync(directory, { recursive: true, force: true });
    }
  }

  #claim(kind: "export" | "import"): string {
    if (this.#active !== null) throw new DumpLedgerError("invalid_transition", `a transfer job (${this.#active}) is already running`);
    const id = `${kind}_${randomBytes(16).toString("hex")}`;
    this.#active = id;
    return id;
  }

  #release(): void {
    this.#active = null;
  }

  /** Starts an export job; the summary resolves when the bundle is sealed (or the job failed). */
  startExport(): Promise<ExportSummary> {
    const exportId = this.#claim("export");
    const createdAt = new Date().toISOString();
    this.#exports.set(exportId, { exportId, status: "running", createdAt, byteSize: null, error: null });
    const finish = (summary: ExportSummary): ExportSummary => {
      this.#exports.set(exportId, summary);
      this.#release();
      return summary;
    };
    try {
      return exportBundle({
        engine: this.#engine,
        vault: this.#vault,
        exportsDir: this.#exportsDir,
        exportId,
        createdAt,
        ...(this.#generatorVersion !== undefined ? { generatorVersion: this.#generatorVersion } : {}),
      }).then(finish, (error: unknown) => finish({ exportId, status: "failed", createdAt, byteSize: null, error: errorMessage(error) }));
    } catch (error) {
      const failed: ExportSummary = { exportId, status: "failed", createdAt, byteSize: null, error: errorMessage(error) };
      this.#exports.set(exportId, failed);
      this.#release();
      throw error;
    }
  }

  /** Starts an import job; the job view resolves when the import finishes (or fails). */
  startImport(bundlePath: string): Promise<ImportJob> {
    const importId = this.#claim("import");
    this.#imports.set(importId, { importId, status: "running", verified: 0, imported: 0, rejected: 0, skipped: 0, error: null });
    try {
      const outcome = importBundle({ engine: this.#engine, vault: this.#vault, bundlePath, workDir: this.#exportsDir });
      const job: ImportJob = {
        importId,
        status: outcome.status,
        verified: outcome.verified,
        imported: outcome.imported,
        rejected: outcome.rejected,
        skipped: outcome.skipped,
        error: outcome.error,
      };
      this.#imports.set(importId, job);
      this.#release();
      return Promise.resolve(job);
    } catch (error) {
      this.#imports.set(importId, { importId, status: "failed", verified: 0, imported: 0, rejected: 0, skipped: 0, error: errorMessage(error) });
      this.#release();
      throw error;
    }
  }

  listExports(): readonly ExportSummary[] {
    return [...this.#exports.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.exportId < b.exportId ? -1 : 1));
  }

  getExport(exportId: string): ExportSummary | undefined {
    return this.#exports.get(exportId);
  }

  getImport(importId: string): ImportJob | undefined {
    return this.#imports.get(importId);
  }

  /** Removes a sealed (or failed) export's bundle from disk and drops its record. */
  deleteExport(exportId: string): void {
    if (!JOB_ID_PATTERN.test(exportId)) throw new DumpLedgerError("invalid_input", "invalid export identifier");
    if (this.#active === exportId) throw new DumpLedgerError("invalid_transition", "cannot delete an export while it is running");
    const record = this.#exports.get(exportId);
    if (record === undefined) throw new DumpLedgerError("not_found", "export was not found");
    rmSync(join(this.#exportsDir, exportId), { recursive: true, force: true });
    this.#exports.delete(exportId);
  }
}
