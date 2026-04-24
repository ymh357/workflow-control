import { describe, it, expect } from "vitest";
import {
  scanImports,
  findDisallowedImports,
  NODE_IMPORT_WHITELIST,
} from "./scan-imports.js";

describe("scanImports", () => {
  it("extracts plain import declarations", () => {
    const r = scanImports(`
      import "side-effect-only";
      import x from "default-import";
      import { a, b } from "named-import";
      import * as ns from "namespace-import";
    `);
    expect(r.imports.map((i) => i.specifier).sort()).toEqual([
      "default-import", "named-import", "namespace-import", "side-effect-only",
    ]);
  });

  it("extracts import-equals-require syntax", () => {
    const r = scanImports(`import f = require("legacy-import");`);
    expect(r.imports[0]!.specifier).toBe("legacy-import");
  });

  it("extracts re-exports", () => {
    const r = scanImports(`
      export { a } from "reexport-named";
      export * from "reexport-star";
      export * as n from "reexport-namespace";
    `);
    expect(r.imports.map((i) => i.specifier).sort()).toEqual([
      "reexport-named", "reexport-namespace", "reexport-star",
    ]);
  });

  it("extracts dynamic import() with string-literal arg", () => {
    const r = scanImports(`
      async function go() {
        const m = await import("lazy-static");
        return m;
      }
    `);
    expect(r.imports[0]!.specifier).toBe("lazy-static");
    expect(r.dynamicImports).toEqual([]);
  });

  it("flags dynamic import() with non-string arg as dynamic", () => {
    const r = scanImports(`
      async function go(name: string) {
        const m = await import(name);
        return m;
      }
    `);
    expect(r.imports).toEqual([]);
    expect(r.dynamicImports.length).toBe(1);
  });

  it("extracts require() with string-literal arg", () => {
    const r = scanImports(`const fs = require("node:fs");`);
    expect(r.imports[0]!.specifier).toBe("node:fs");
  });

  it("flags require() with non-string as dynamic", () => {
    const r = scanImports(`
      function load(name: string) {
        return require(name);
      }
    `);
    expect(r.imports).toEqual([]);
    expect(r.dynamicImports.length).toBe(1);
  });

  it("records 1-based line for each import", () => {
    const r = scanImports(`// line 1
// line 2
import { a } from "foo";
// line 4
import "bar";
`);
    const foo = r.imports.find((i) => i.specifier === "foo");
    const bar = r.imports.find((i) => i.specifier === "bar");
    expect(foo!.line).toBe(3);
    expect(bar!.line).toBe(5);
  });
});

describe("NODE_IMPORT_WHITELIST", () => {
  it("includes the safe I/O modules", () => {
    for (const m of [
      "node:fs/promises",
      "node:path",
      "node:crypto",
      "node:url",
      "node:buffer",
      "node:os",
      "node:util",
    ]) {
      expect(NODE_IMPORT_WHITELIST.has(m)).toBe(true);
    }
  });
  it("excludes dangerous modules", () => {
    for (const m of [
      "node:child_process",
      "node:worker_threads",
      "node:vm",
      "node:cluster",
      "node:fs", // sync apis excluded; only fs/promises allowed
      "node:net",
      "node:dgram",
      "node:tls",
      "node:http",
      "node:https",
      "node:process",
    ]) {
      expect(NODE_IMPORT_WHITELIST.has(m)).toBe(false);
    }
  });
});

describe("findDisallowedImports", () => {
  it("returns an empty list when every import is whitelisted", () => {
    const scan = scanImports(`
      import { readFile } from "node:fs/promises";
      import { join } from "node:path";
    `);
    expect(findDisallowedImports(scan.imports)).toEqual([]);
  });

  it("flags non-whitelisted node: modules", () => {
    const scan = scanImports(`
      import { spawn } from "node:child_process";
      import { readFileSync } from "node:fs";
    `);
    const bad = findDisallowedImports(scan.imports);
    expect(bad.map((i) => i.specifier).sort()).toEqual([
      "node:child_process", "node:fs",
    ]);
  });

  it("flags third-party npm packages (AI hallucination guard)", () => {
    const scan = scanImports(`
      import axios from "axios";
      import lodash from "lodash";
      import rimraf from "rimraf";
    `);
    const bad = findDisallowedImports(scan.imports);
    expect(bad.map((i) => i.specifier).sort()).toEqual([
      "axios", "lodash", "rimraf",
    ]);
  });

  it("flags bare relative imports too (no local file resolution at submit time)", () => {
    const scan = scanImports(`
      import { helper } from "./helper.js";
      import { other } from "../lib/other.js";
    `);
    const bad = findDisallowedImports(scan.imports);
    expect(bad.length).toBe(2);
  });
});
