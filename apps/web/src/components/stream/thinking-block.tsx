import { useState } from "react";
import type { MessageGroup } from "@/lib/message-grouping";

const ThinkingBlock = ({ group }: { group: MessageGroup }) => {
  const [open, setOpen] = useState(false);
  const text = group.thinkingText ?? group.messages[0]?.content ?? "";
  const preview = text.length > 120 ? text.slice(0, 120) + "..." : text;

  return (
    <div className="border-l-2 border-l-violet-500 pl-3 py-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-start gap-2 text-left w-full"
      >
        <span className="text-[10px] text-zinc-600 shrink-0" suppressHydrationWarning>
          {new Date(group.timestamp).toLocaleTimeString()}
        </span>
        <span className="text-[10px] text-violet-500 font-mono shrink-0">
          {open ? "\u25BC" : "\u25B6"}
        </span>
        <span className="text-[10px] italic text-violet-400/60 truncate">
          {preview}
        </span>
      </button>
      {open && (
        <div className="mt-1 ml-4 max-h-64 overflow-auto rounded bg-zinc-900/50 p-2">
          <p className="text-xs text-violet-300/70 whitespace-pre-wrap">{text}</p>
        </div>
      )}
    </div>
  );
};

export default ThinkingBlock;
