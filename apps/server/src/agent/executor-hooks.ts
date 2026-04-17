import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { resolve as resolvePath } from "node:path";
import { questionManager } from "../lib/question-manager.js";
import { taskLogger } from "../lib/logger.js";

export function createAskUserQuestionInterceptor(taskId: string) {
  return async (toolName: string, input: Record<string, unknown>): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> => {
    if (toolName !== "AskUserQuestion") return { behavior: "allow" };
    taskLogger(taskId).info({ input: JSON.stringify(input).slice(0, 200) }, "AskUserQuestion intercepted");
    const questions = input.questions as Array<{ question: string; options?: Array<{ label: string }> }> | undefined;
    const firstQ = questions?.[0];
    try {
      const answer = await questionManager.ask(taskId, firstQ?.question ?? JSON.stringify(input), firstQ?.options?.map((o) => o.label));
      taskLogger(taskId).info({ answer }, "User answered");
      return { behavior: "deny", message: `The user has answered your question. Their response: "${answer}". Use this answer and continue without calling AskUserQuestion again for this question.` };
    } catch (err) {
      taskLogger(taskId).warn({ err }, "AskUserQuestion interceptor failed");
      return { behavior: "deny", message: "The question timed out or was cancelled. Continue with your best judgment." };
    }
  };
}

export function createSpecAuditHook(taskId: string, specFiles: string[]) {
  const warnedPaths = new Set<string>();
  return async (input: HookInput): Promise<HookJSONOutput> => {
    const toolName = (input as Record<string, unknown>).tool_name as string;
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>;

    if (specFiles.length > 0 && (toolName === "Write" || toolName === "Edit")) {
      const filePath = String(toolInput?.file_path ?? "");
      if (filePath) {
        const isWorkflow = filePath.includes("/.workflow/");
        const matchesSpec = specFiles.some((sf) => filePath.endsWith(`/${sf}`) || filePath.endsWith(sf));
        if (!isWorkflow && !matchesSpec && !warnedPaths.has(filePath)) {
          warnedPaths.add(filePath);
          taskLogger(taskId).info({ filePath, specFiles }, "Write/Edit audit hook: file outside spec scope");
          return {
            decision: "block" as const,
            reason: `File "${filePath.split("/").pop()}" is outside the spec scope (expected: ${specFiles.join(", ")}). If this change is necessary, call AskUserQuestion to inform the user, then retry.`,
          };
        }
      }
    }
    return { decision: "approve" as const };
  };
}

const ALWAYS_DENY_PATTERNS = [
  "/.git/",
  "/node_modules/",
  "/.claude/",
];

// Match real .env secret files: .env, .env.local, .env.production, .env.development.local
// Allow: .envrc, .environment, .env.example, .env.template, .env.sample
const ENV_SAFE_SUFFIXES = [".example", ".template", ".sample", ".defaults"];

function isSensitiveEnvFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? "";
  if (basename === ".env") return true;
  if (!basename.startsWith(".env.")) return false;
  return !ENV_SAFE_SUFFIXES.some(s => basename.endsWith(s));
}

export function createPathRestrictionHook(allowPaths?: string[], denyPaths?: string[]) {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    const toolName = (input as Record<string, unknown>).tool_name as string;
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>;

    if (toolName !== "Write" && toolName !== "Edit") {
      return { decision: "approve" as const };
    }

    const filePath = String(toolInput?.file_path ?? "");
    if (!filePath) return { decision: "approve" as const };

    // Resolve to an absolute path BEFORE matching. path.resolve() canonicalizes
    // `..` segments, which is the whole traversal-defense story: the attacker
    // can craft "/workspace/../etc/passwd" but once resolved it's "/etc/passwd"
    // and no longer matches an allowlist keyed on "/workspace/". All match logic
    // runs against the resolved form only — checking the literal input alongside
    // would either add no safety or over-block legitimate relative paths (a
    // relative file_path like "src/foo.ts" never literally contains an absolute
    // allow rule like "/project/src/", so requiring BOTH to match rejected every
    // legitimate relative-path tool call).
    const resolvedPath = resolvePath(filePath);

    // Always deny sensitive paths (like Claude Code's safety paths).
    for (const pattern of ALWAYS_DENY_PATTERNS) {
      if (resolvedPath.includes(pattern)) {
        return {
          decision: "block" as const,
          reason: `Write to "${filePath}" blocked — matches protected pattern "${pattern}". This restriction cannot be bypassed.`,
        };
      }
    }

    // Check .env files with basename matching.
    if (isSensitiveEnvFile(resolvedPath)) {
      return {
        decision: "block" as const,
        reason: `Write to "${filePath}" blocked — environment files are protected. This restriction cannot be bypassed.`,
      };
    }

    if (denyPaths?.length) {
      for (const dp of denyPaths) {
        if (resolvedPath.includes(dp)) {
          return {
            decision: "block" as const,
            reason: `Write to "${filePath}" blocked — path matches deny rule "${dp}".`,
          };
        }
      }
    }

    if (allowPaths?.length) {
      const allowed = allowPaths.some((ap) => resolvedPath.includes(ap));
      if (!allowed) {
        return {
          decision: "block" as const,
          reason: `Write to "${filePath}" blocked — path not in allowed list: ${allowPaths.join(", ")}.`,
        };
      }
    }

    return { decision: "approve" as const };
  };
}
