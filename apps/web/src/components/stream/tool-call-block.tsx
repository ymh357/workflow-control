import { useState } from "react";
import { useTranslations } from "next-intl";
import type { MessageGroup } from "@/lib/message-grouping";
import { humanizeToolCall } from "./utils";

const ToolCallBlock = ({ group }: { group: MessageGroup }) => {
  const t = useTranslations("Stream");
  const [open, setOpen] = useState(false);
  const toolMsg = group.messages[0];
  const toolName = String(toolMsg?.detail?.toolName ?? group.toolName ?? t("unknown"));
  const input = toolMsg?.detail?.input as Record<string, unknown> | undefined;
  const summary = humanizeToolCall(toolName, input);
  const resultMsg = group.messages.find((m) => m.type === "agent_tool_result");

  return (
    <div className="border-l-2 border-l-blue-500 pl-3 py-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-left w-full group"
      >
        <span className="text-[10px] text-zinc-600 shrink-0" suppressHydrationWarning>
          {new Date(group.timestamp).toLocaleTimeString()}
        </span>
        <span className="text-[10px] text-blue-500 font-mono shrink-0">
          {open ? "\u25BC" : "\u25B6"}
        </span>
        <span className="text-xs text-blue-400 truncate">{summary}</span>
      </button>
      {open && (
        <div className="mt-1 ml-4 space-y-1">
          {input && (
            <pre className="max-h-48 overflow-auto rounded bg-zinc-900 p-2 text-[11px] text-zinc-500">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
          {resultMsg && (
            <pre className="max-h-32 overflow-auto rounded bg-zinc-900/50 p-2 text-[11px] text-zinc-600">
              {resultMsg.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallBlock;
