import { execFile, type ExecFileException } from "node:child_process";
import type { Diagnostic } from "../ir/schema.js";

export type HealthCheckResult =
  | { ok: true }
  | { ok: false; diagnostics: Diagnostic[] };

export type EnvKeyInput = { name: string; required: boolean };

export function checkEnvKeys(args: {
  envKeys: EnvKeyInput[];
  haveValues: Set<string>;
}): HealthCheckResult {
  const missing = args.envKeys
    .filter((k) => k.required && !args.haveValues.has(k.name))
    .map((k) => k.name);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    diagnostics: [{
      code: "MCP_PROVISION_ENVKEY_MISSING",
      message: `required envKeys missing: [${missing.join(", ")}]`,
      context: { missing },
    }],
  };
}

export function resolvePackageName(args: { packageName?: string; args: string[] }): string | null {
  if (args.packageName && args.packageName.length > 0) return args.packageName;
  for (const a of args.args) {
    if (!a.startsWith("-")) return a;
  }
  return null;
}

export type ExecFn = (cmd: string, argv: string[], opts: { timeoutMs: number }) => Promise<{
  code: number; stdout: string; stderr: string; timedOut: boolean;
}>;

const defaultExec: ExecFn = (cmd, argv, opts) => new Promise((resolve) => {
  execFile(cmd, argv, { timeout: opts.timeoutMs }, (err: ExecFileException | null, stdout, stderr) => {
    const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
    const timedOut = err?.killed === true && err?.signal === "SIGTERM";
    resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
  });
});

export async function checkPackage(args: {
  packageName: string;
  timeoutMs: number;
  exec?: ExecFn;
}): Promise<HealthCheckResult> {
  const exec = args.exec ?? defaultExec;
  const result = await exec("npm", ["view", args.packageName, "version"], { timeoutMs: args.timeoutMs });
  if (result.timedOut) {
    return {
      ok: false,
      diagnostics: [{
        code: "MCP_PROVISION_HEALTHCHECK_TIMEOUT",
        message: `npm view ${args.packageName} timed out after ${args.timeoutMs}ms`,
        context: { packageName: args.packageName, timeoutMs: args.timeoutMs },
      }],
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      diagnostics: [{
        code: "MCP_PROVISION_PACKAGE_NOT_FOUND",
        message: `npm view ${args.packageName} exit ${result.code}: ${result.stderr.slice(0, 200)}`,
        context: { packageName: args.packageName, code: result.code },
      }],
    };
  }
  return { ok: true };
}
