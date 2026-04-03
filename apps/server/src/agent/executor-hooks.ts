import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
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
