// JSONL line -> SessionEvent[]. One JSONL line can yield 0..N events
// (an assistant turn with text + multiple tool_use blocks emits one
// event per block).

import { createHash } from "node:crypto";
import { redact } from "./redactor.js";
import type { SessionEvent, SessionEventRole } from "../types.js";

const EXCERPT_LIMIT = 4096;
const TOOL_ARGS_LIMIT = 1024;

export interface ParseContext {
  sessionId: string;
  nextSeq: number;
}

export function parseLine(line: string, ctx: ParseContext): SessionEvent[] {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return []; }
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const sessionId = (obj.sessionId as string) ?? ctx.sessionId;
  if (!sessionId) return [];

  // Skip control-plane lines.
  if (obj.type === "permission-mode") return [];
  if (obj.attachment && typeof obj.attachment === "object") return [];

  const ts = typeof obj.timestamp === "number"
    ? obj.timestamp
    : typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Date.now();

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return [];

  const role = mapRole(message.role as string | undefined, obj.type as string | undefined);
  if (!role) return [];

  const events: SessionEvent[] = [];
  const content = message.content;
  if (typeof content === "string") {
    events.push(buildEvent(ctx, sessionId, ts, role, content, null, null));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        events.push(buildEvent(ctx, sessionId, ts, role, b.text, null, null));
      } else if (b.type === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "<unknown>";
        const args = JSON.stringify(b.input ?? {});
        events.push(buildEvent(ctx, sessionId, ts, "tool_use", null, name, args));
      } else if (b.type === "tool_result") {
        const txt = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        events.push(buildEvent(ctx, sessionId, ts, "tool_result", txt, null, null));
      }
    }
  }
  return events;
}

function mapRole(messageRole: string | undefined, lineType: string | undefined): SessionEventRole | null {
  if (messageRole === "user") return "user";
  if (messageRole === "assistant") return "assistant";
  if (lineType === "system") return "system";
  return null;
}

function buildEvent(
  ctx: ParseContext, sessionId: string, ts: number, role: SessionEventRole,
  text: string | null, toolName: string | null, toolArgs: string | null,
): SessionEvent {
  const seq = ctx.nextSeq++;
  let textExcerpt: string | null = null;
  let textHash: string | null = null;
  let textLength: number | null = null;
  if (text !== null) {
    textLength = text.length;
    textHash = createHash("sha256").update(text, "utf8").digest("hex");
    const r = redact(text.slice(0, EXCERPT_LIMIT));
    textExcerpt = r.redacted;
  }
  let toolArgsExcerpt: string | null = null;
  if (toolArgs !== null) {
    const r = redact(toolArgs.slice(0, TOOL_ARGS_LIMIT));
    toolArgsExcerpt = r.redacted;
  }
  return {
    sessionId, seq, ts, role,
    textExcerpt, textHash, textLength,
    toolName, toolArgsExcerpt,
  };
}
