// Type-level validation of a PipelineIR via tsc subprocess.
//
// Pipeline:
//   IR -> codegen emit-ts -> pipeline.ts + tsconfig.json (temp dir)
//      -> spawn tsc --noEmit --pretty false
//      -> parse stdout for TS2322 errors
//      -> map each error back to its originating wire via either
//         the identifier name (preferred) or source line (fallback)
//      -> return structured Diagnostic[]
//
// See docs/kernel-next-design.md §5.3. Phase 2 will switch to ts-morph
// in-process Program for sub-second feedback; spike period accepts 3-5s.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { PipelineIR, Diagnostic } from "../ir/schema.js";
import { emitPipelineModule, type WireMapEntry } from "../codegen/emit-ts.js";
import { renderTsconfigJson } from "../codegen/tsconfig-template.js";

export interface TypeValidationOptions {
  tscPath?: string;  // overrides `npx tsc`; useful for tests using monorepo binary
  keepTemp?: boolean; // leave tempdir for debugging
}

// tsSource + tempDir are always populated regardless of ok/not ok, for
// observability + debugging.
export type TypeValidationOutcome =
  | { ok: true; tsSource: string; tempDir: string }
  | { ok: false; diagnostics: Diagnostic[]; tsSource: string; tempDir: string };

export function validateTypes(
  ir: PipelineIR,
  options: TypeValidationOptions = {},
): TypeValidationOutcome {
  const emitted = emitPipelineModule(ir);
  const dir = mkdtempSync(join(tmpdir(), "kernel-next-tsc-"));
  writeFileSync(join(dir, "pipeline.ts"), emitted.source, "utf8");
  writeFileSync(join(dir, "tsconfig.json"), renderTsconfigJson(), "utf8");

  const result = runTsc(dir, options.tscPath);

  try {
    if (result.exitCode === 0) {
      return { ok: true, tsSource: emitted.source, tempDir: dir };
    }

    const diagnostics = parseTscOutput(result.stdout, emitted.wireByIdentifier, emitted.wireByLine);

    // Fallback: if tsc emitted errors but we couldn't extract any wire
    // diagnostics, surface a raw error so the caller isn't blind.
    if (diagnostics.length === 0) {
      diagnostics.push({
        code: "WIRE_TYPE_MISMATCH",
        message: `tsc reported errors that could not be mapped to any wire:\n${result.stdout}`,
        context: {
          rawStdout: result.stdout,
          stderr: result.stderr,
          sourcePreview: emitted.source.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n"),
          knownWireLines: Array.from(emitted.wireByLine.keys()).sort((a, b) => a - b),
        },
      });
    }

    return { ok: false, diagnostics, tsSource: emitted.source, tempDir: dir };
  } finally {
    if (!options.keepTemp) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

interface TscResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runTsc(dir: string, tscPath?: string): TscResult {
  // Prefer explicit tscPath, else use `npx tsc` (resolves from monorepo nearby).
  const cmd = tscPath ?? "npx";
  const args = tscPath
    ? ["--noEmit", "--pretty", "false", "-p", dir]
    : ["tsc", "--noEmit", "--pretty", "false", "-p", dir];

  const proc = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: dir,
    // Avoid leaking repo-level tsconfig when npx resolves a nearby one.
    env: { ...process.env, TS_NODE_PROJECT: "", },
  });

  return {
    exitCode: typeof proc.status === "number" ? proc.status : 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

// tsc --pretty false output (per error line). With `-p dir`, tsc reports
// the file as an absolute or relative path like:
//   /tmp/kernel-next-tsc-XYZ/pipeline.ts(12,5): error TS2322: ...
// We anchor on `pipeline.ts(` anywhere in the line.
const TSC_ERROR_REGEX =
  /(?:^|[\/\\])pipeline\.ts\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
const TYPE_EXTRACT_REGEX = /Type\s+'([^']+)'\s+is not assignable to type\s+'([^']+)'/;

function parseTscOutput(
  stdout: string,
  wireByIdentifier: Map<string, WireMapEntry>,
  wireByLine: Map<number, WireMapEntry>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>(); // dedupe: multiple lines can refer to same wire

  let match: RegExpExecArray | null;
  TSC_ERROR_REGEX.lastIndex = 0;
  while ((match = TSC_ERROR_REGEX.exec(stdout)) !== null) {
    const [, lineStr, , code, message] = match;
    const line = parseInt(lineStr!, 10);
    if (code !== "TS2322") continue; // only wire mismatches for now

    // Resolve wire: try line-based lookup; wireByIdentifier is only useful if
    // tsc reported the identifier by name, which it doesn't in the -p form.
    const wire = wireByLine.get(line);
    if (!wire) continue;

    const key = `${wire.fromStage}.${wire.fromPort}->${wire.toStage}.${wire.toPort}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const typeMatch = message!.match(TYPE_EXTRACT_REGEX);
    const fromActual = typeMatch?.[1] ?? wire.fromType;
    const toActual = typeMatch?.[2] ?? wire.toType;

    diagnostics.push({
      code: "WIRE_TYPE_MISMATCH",
      message:
        `Wire ${wire.fromStage}.${wire.fromPort} -> ${wire.toStage}.${wire.toPort}: ` +
        `type '${fromActual}' is not assignable to '${toActual}'.`,
      context: {
        wire: {
          from: { stage: wire.fromStage, port: wire.fromPort },
          to: { stage: wire.toStage, port: wire.toPort },
        },
        fromType: fromActual,
        toType: toActual,
        tsMessage: message,
      },
    });

    // Used for tests / debug to distinguish identifier-based vs line-based hit.
    void wireByIdentifier;
  }

  return diagnostics;
}
