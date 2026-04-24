// Extract every import specifier referenced in an inline TypeScript
// script via AST traversal. Used at submit time to enforce the
// kernel's import whitelist for AI-authored scripts.
//
// Covers:
//   - import "foo"
//   - import x from "foo"
//   - import { x } from "foo"
//   - import * as x from "foo"
//   - import x = require("foo")     (legacy syntax; still emit)
//   - dynamic import("foo") when the arg is a string literal
//   - export { x } from "foo"
//   - export * from "foo"
//   - export * as x from "foo"
//
// NOT covered (conservative — these are reported as "dynamic"):
//   - import(expr) where expr is not a string literal — AI can't
//     smuggle modules through this because we'd report it as
//     DYNAMIC_IMPORT and fail the whitelist anyway.
//   - require(expr) from non-string — same treatment.

import ts from "typescript";

export interface ImportFinding {
  /** The module specifier (e.g. "node:fs/promises", "typescript"). */
  specifier: string;
  /** 1-based line in source. */
  line: number;
}

export interface ScanResult {
  /** Every static import specifier found, in source order. */
  imports: ImportFinding[];
  /**
   * 1-based lines where a dynamic import() with a non-string-literal
   * argument was found. These are always whitelist-hostile because we
   * can't know what module loads at runtime; callers typically reject.
   */
  dynamicImports: number[];
}

export function scanImports(source: string): ScanResult {
  const sf = ts.createSourceFile(
    "inline.ts",
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const imports: ImportFinding[] = [];
  const dynamicImports: number[] = [];

  function lineOf(node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  function visit(node: ts.Node): void {
    // import "foo"; import x from "foo"; import { a } from "foo";
    // import * as x from "foo";
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        imports.push({ specifier: spec.text, line: lineOf(spec) });
      }
    }
    // import x = require("foo")
    else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({
        specifier: node.moduleReference.expression.text,
        line: lineOf(node.moduleReference.expression),
      });
    }
    // export { x } from "foo"; export * from "foo"; export * as n from "foo"
    else if (
      (ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node.moduleSpecifier),
      });
    }
    // dynamic import("foo") or require("foo") — CallExpression
    else if (ts.isCallExpression(node)) {
      const isImportExpr = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireExpr =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImportExpr || isRequireExpr) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          imports.push({ specifier: arg.text, line: lineOf(arg) });
        } else if (arg) {
          dynamicImports.push(lineOf(node));
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  return { imports, dynamicImports };
}

// ---------- whitelist ----------

/**
 * Node stdlib modules an inline script may import. The list excludes
 * anything that spawns arbitrary processes (child_process, vm,
 * worker_threads), loads native code (dlopen, node-gyp modules), or
 * bypasses the kernel's env-token scoping (cluster, process).
 *
 * Rationale for specific exclusions:
 *   - child_process: spawning shell commands belongs to agent prompts
 *     (where the runner already audits Bash tool usage), not to a
 *     submit-time-validated script.
 *   - worker_threads / vm / cluster: sandbox-escaping vectors irrelevant
 *     to any reasonable I/O script.
 *   - net / dgram / tls / http / https: http_fetch / http_request
 *     builtin modules already cover network I/O; raw sockets aren't
 *     needed and complicate mock-based testing.
 *   - fs (sync APIs): scripts should be async; require node:fs/promises
 *     so the caller isn't forced to wrap readFileSync in a worker.
 *     (fs sync calls block the kernel's event loop, blocking other
 *     stage_attempts and SSE ticks on the same server.)
 *
 * A first-party npm dependency that isn't a node: builtin goes through
 * a separate review and registers explicitly here; we don't maintain a
 * generic "allow anything from dependencies" mechanism because AI can
 * and does hallucinate package names.
 */
export const NODE_IMPORT_WHITELIST: ReadonlySet<string> = new Set([
  "node:fs/promises",
  "node:path",
  "node:crypto",
  "node:url",
  "node:buffer",
  "node:os",
  "node:util",
  "node:stream/promises",
  "node:zlib",
]);

/**
 * Return the subset of imports that are not on the whitelist. Each
 * entry comes from `scanImports().imports`. The caller turns them into
 * SCRIPT_IMPORT_NOT_WHITELISTED diagnostics.
 */
export function findDisallowedImports(
  imports: ImportFinding[],
): ImportFinding[] {
  return imports.filter((imp) => !NODE_IMPORT_WHITELIST.has(imp.specifier));
}
