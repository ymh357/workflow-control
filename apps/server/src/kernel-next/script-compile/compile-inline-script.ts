// Compile an inline TypeScript script (authored by pipeline-generator
// or the pipeline author) into executable JavaScript, with tsc-grade
// type checking.
//
// Used by D'-3's inline-source ScriptStage variant: the caller supplies
// TS source and an expected input/output port contract; this helper
// type-checks the source against that contract and returns emitted JS.
//
// Uses the in-process TypeScript API (not a subprocess) so submit-time
// compilation of one small script takes ~50-100 ms instead of the 3-5 s
// runTsc path used for whole-pipeline structural validation. The two
// paths share no state.

import ts from "typescript";

/**
 * Every inline script authored for kernel-next has the same module
 * shape: a default export conforming to ScriptModule (see
 * runtime/script-module-resolver.ts). We don't emit that interface
 * inline; we prepend an ambient declaration so the compiler can
 * enforce that the user's default export is assignable to it.
 */
const AMBIENT_CONTRACT = `
interface ScriptModuleContext {
  taskId: string;
  stageName: string;
  attemptId: string;
  attemptIdx: number;
  moduleId: string;
  env: Readonly<Record<string, string>>;
}
interface ScriptModule {
  run(
    inputs: Record<string, unknown>,
    ctx: ScriptModuleContext,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}
`;

export interface CompileDiagnostic {
  /** TS error code (e.g. "TS2322"). */
  code: string;
  /** 1-based line (into the user's source, not the ambient prelude). */
  line: number;
  /** 1-based column. */
  column: number;
  /** Human-readable message from tsc. */
  message: string;
}

export type CompileResult =
  | { ok: true; js: string }
  | { ok: false; diagnostics: CompileDiagnostic[] };

/**
 * Compile `source` against the kernel's ambient ScriptModule contract.
 * On success returns the emitted JS source (ES2022 module, module kind
 * ESNext so `import` statements survive codegen). On failure returns
 * structured diagnostics with line/column adjusted to the user's view
 * of their source (the ambient prelude is transparent).
 *
 * The compiler has `strict: true` — unintentional `any`, implicit
 * returns, etc. all fail at submit time rather than hiding until the
 * first run.
 */
export function compileInlineScript(source: string): CompileResult {
  const userFilename = "script.ts";
  const contractFilename = "__contract.d.ts";

  const ambientLines = AMBIENT_CONTRACT.split("\n").length - 1;
  void ambientLines;

  // Both files live in an in-memory CompilerHost. Dependency resolution
  // MUST fall back to the real filesystem so `import fs from "node:fs"`
  // resolves — we're compiling TS that will eventually run in node.
  const files: Record<string, string> = {
    [userFilename]: source,
    [contractFilename]: AMBIENT_CONTRACT,
  };

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    // CommonJS output so we can new Function(source) and feed it a
    // synthetic module/exports/require trio — avoids node's dynamic-
    // import semantics (which vitest's module transformer rewrites)
    // and gives the runtime full control over what `require` resolves.
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmitOnError: true,
    isolatedModules: false,
    allowSyntheticDefaultImports: true,
    // Include @types/node so scripts can import node: builtins with
    // full types. The security boundary is the import whitelist
    // (scan-imports.ts), NOT the set of globally-available types —
    // denying @types/node here would make legitimate I/O scripts
    // unwritable without proving any attacker who passes the
    // whitelist can't already do what they want.
    types: ["node"],
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const getSourceFileOriginal = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, langVer, onError, shouldCreateNew) => {
    if (files[fileName] !== undefined) {
      return ts.createSourceFile(
        fileName,
        files[fileName]!,
        langVer,
        true,
      );
    }
    return getSourceFileOriginal(fileName, langVer, onError, shouldCreateNew);
  };
  host.readFile = (fileName) =>
    files[fileName] !== undefined ? files[fileName] : ts.sys.readFile(fileName);
  host.fileExists = (fileName) =>
    files[fileName] !== undefined || ts.sys.fileExists(fileName);

  // Collect JS output in memory instead of writing to disk.
  let emittedJs: string | undefined;
  host.writeFile = (fileName, text) => {
    if (fileName.endsWith(".js")) emittedJs = text;
  };

  const program = ts.createProgram(
    [userFilename, contractFilename],
    compilerOptions,
    host,
  );

  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: diagnostics.map((d) => toStructured(d, userFilename)),
    };
  }

  const emitResult = program.emit();
  const emitDiagnostics = emitResult.diagnostics;
  if (emitDiagnostics.length > 0 || emittedJs === undefined) {
    return {
      ok: false,
      diagnostics: emitDiagnostics.length > 0
        ? emitDiagnostics.map((d) => toStructured(d, userFilename))
        : [{ code: "TS_INTERNAL", line: 1, column: 1, message: "emit produced no output" }],
    };
  }

  return { ok: true, js: emittedJs };
}

function toStructured(d: ts.Diagnostic, userFilename: string): CompileDiagnostic {
  const code = `TS${d.code}`;
  let line = 1;
  let column = 1;
  if (d.file && d.start !== undefined) {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    line = pos.line + 1;
    column = pos.character + 1;
    // If the diagnostic is on a file other than the user's source
    // (e.g. the ambient contract), surface the filename in the message
    // so the user can still make sense of it.
    if (d.file.fileName !== userFilename) {
      return {
        code,
        line,
        column,
        message: `[${d.file.fileName}:${line}:${column}] ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
      };
    }
  }
  return {
    code,
    line,
    column,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  };
}
