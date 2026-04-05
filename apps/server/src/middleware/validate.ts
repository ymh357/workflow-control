import { z, type ZodSchema } from "zod";
import type { Context, Next } from "hono";
import { errorResponse, ErrorCode } from "../lib/error-response.js";

// --- UUID middleware ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validateTaskId = async (c: Context, next: Next) => {
  const taskId = c.req.param("taskId");
  if (taskId && !UUID_RE.test(taskId)) {
    return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "Invalid taskId format");
  }
  await next();
};

// --- Generic Zod body validator ---

type ValidatedEnv = { validatedBody: unknown };

export function validateBody<T>(schema: ZodSchema<T>, errorMessage = "Validation failed") {
  return async (c: Context<{ Variables: ValidatedEnv }>, next: Next) => {
    let raw: unknown;
    try {
      const text = await c.req.text();
      if (!text || text.trim() === "") {
        raw = {};
      } else {
        raw = JSON.parse(text);
      }
    } catch {
      return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, "Invalid JSON body");
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      const errors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      return errorResponse(c, 400, ErrorCode.VALIDATION_FAILED, errorMessage, errors);
    }

    c.set("validatedBody", result.data);
    await next();
  };
}

export function getValidatedBody<T>(c: Context<{ Variables: ValidatedEnv }>): T {
  return c.get("validatedBody") as T;
}

// --- Schemas ---

export const createTaskSchema = z.object({
  taskText: z.string().min(1),
  repoName: z.string().optional(),
  pipelineName: z.string().optional(),
  edge: z.boolean().optional(),
});

export const answerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1),
});

export const rejectSchema = z.object({
  reason: z.string().optional(),
  feedback: z.string().optional(),
  targetStage: z.string().optional(),
});

export const confirmSchema = z.object({
  repoName: z.string().optional(),
});

export const yamlContentSchema = z.object({
  content: z.string(),
});

export const sandboxSchema = z.object({
  enabled: z.boolean().optional(),
  auto_allow_bash: z.boolean().optional(),
  allow_unsandboxed_commands: z.boolean().optional(),
  network: z.object({
    allowed_domains: z.array(z.string()).optional(),
  }).optional(),
  filesystem: z.object({
    allow_write: z.array(z.string()).optional(),
    deny_write: z.array(z.string()).optional(),
    deny_read: z.array(z.string()).optional(),
  }).optional(),
});

export const taskConfigUpdateSchema = z.object({
  config: z.object({
    pipelineName: z.string().optional(),
    pipeline: z.record(z.string(), z.unknown()).optional(),
    prompts: z.object({
      system: z.record(z.string(), z.string()).optional(),
      fragments: z.record(z.string(), z.string()).optional(),
      fragmentMeta: z.record(z.string(), z.unknown()).optional(),
      globalConstraints: z.string().optional(),
      globalClaudeMd: z.string().optional(),
      globalGeminiMd: z.string().optional(),
      globalCodexMd: z.string().optional(),
    }).optional(),
    skills: z.array(z.string()).optional(),
    mcps: z.array(z.string()).optional(),
    sandbox: z.record(z.string(), z.unknown()).optional(),
    agent: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
});

export const interruptSchema = z.object({
  message: z.string().optional(),
});

export const retrySchema = z.object({
  sync: z.boolean().optional(),
});
