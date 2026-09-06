import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Boundary enforcement for the framework-free rule: the library sources under
 * `src/` must not import any Node, Fastify, React, DOM, filesystem, SQLite,
 * engine, or external runtime module. This test scans the import graph statically
 * (source) and the emitted CommonJS/ESM output (after `pnpm run build`), so the
 * rule holds for whatever a consumer actually loads from `dist/src`.
 */

// Compiled test lives at dist/test/boundaries.test.js, so the package root is two
// levels up (dist/test -> dist -> package). Source modules live in src/, and the
// built output the boundary must also scan lives in dist/src/.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_DIR = join(PACKAGE_ROOT, "src");
const EMITTED_DIR = join(PACKAGE_ROOT, "dist", "src");

const FORBIDDEN_SPECIFIERS = [
  "node:",
  "fastify",
  "react",
  "react-dom",
  "@vitejs",
  "better-sqlite3",
  "sqlite",
  "mirrorecma",
  "vault",
  "engine",
  "fs",
  "path",
  "url",
  "stream",
  "http",
  "https",
];

const IMPORT_PATTERN = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;

function listTypeScriptSources(): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => join(SOURCE_DIR, name));
}

function listEmittedJavaScript(): string[] {
  try {
    return readdirSync(EMITTED_DIR)
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(EMITTED_DIR, name));
  } catch {
    return [];
  }
}

function specifiersOf(content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

function assertNoForbiddenImports(file: string, specifiers: readonly string[]): void {
  for (const specifier of specifiers) {
    for (const forbidden of FORBIDDEN_SPECIFIERS) {
      assert.ok(
        !specifier.includes(forbidden),
        `${file} must not import "${specifier}" (contains forbidden "${forbidden}")`,
      );
    }
  }
}

describe("framework-free import boundary", () => {
  it("declares no forbidden module import in any library source", () => {
    const sources = listTypeScriptSources();
    assert.ok(sources.length >= 5, "expected several contract modules to exist");
    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      assertNoForbiddenImports(file, specifiersOf(content));
    }
  });

  it("imports only sibling library modules from within src/", () => {
    const sources = listTypeScriptSources();
    const directory = SOURCE_DIR;
    for (const file of sources) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) {
          assert.fail(`${file} imports a bare specifier "${specifier}"`);
        }
        const resolved = join(directory, specifier);
        const tsFile = resolved.replace(/\.js$/, ".ts");
        assert.ok(
          statSync(tsFile, { throwIfNoEntry: false })?.isFile() === true,
          `${file} imports "${specifier}" which does not resolve inside src/`,
        );
        const rel = relative(directory, tsFile);
        assert.ok(!rel.startsWith(".."), `${file} escapes the src/ directory via "${specifier}"`);
      }
    }
  });

  it("emits no forbidden module import in the built dist/src output", () => {
    const emitted = listEmittedJavaScript();
    for (const file of emitted) {
      assertNoForbiddenImports(file, specifiersOf(readFileSync(file, "utf8")));
    }
  });

  it("exposes no Node-only or DOM-only types from the package entry", () => {
    const indexPath = join(SOURCE_DIR, "index.ts");
    const indexContent = readFileSync(indexPath, "utf8");
    for (const forbidden of FORBIDDEN_SPECIFIERS) {
      assert.ok(!indexContent.includes(`from "${forbidden}`), `index.ts must not import ${forbidden}`);
      assert.ok(!indexContent.includes(`from '${forbidden}`), `index.ts must not import ${forbidden}`);
    }
  });
});

describe("dependency manifest", () => {
  it("keeps the package free of runtime framework dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.ok(manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0);
    const dev = manifest.devDependencies ?? {};
    assert.deepEqual(Object.keys(dev).sort(), ["@types/node", "typescript"]);
  });
});
