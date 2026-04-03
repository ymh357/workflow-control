import { useEffect, useRef, useState, useMemo, useCallback, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { groupMessages, type MessageGroup } from "@/lib/message-grouping";
import type { DisplayMessage } from "@/lib/types";
import GroupRenderer from "./stream/group-renderer";
import StatusBar from "./stream/status-bar";

interface MessageStreamProps {
  messages: DisplayMessage[];
  isConnecting: boolean;
  scrollToStage?: string;
  isRunning?: boolean;
  elapsed?: number;
  agentProgress?: { toolCallCount: number; phase: string; thinkingSnippet: string };
  engine?: string;
  currentStage?: string;
  worktreePath?: string;
}

type FilterMode = "all" | "agent" | "tools" | "system";

const AGENT_TYPES = new Set(["agent_text", "user_message"]);
const TOOL_TYPES = new Set(["agent_tool_use", "agent_tool_result", "agent_thinking"]);

const getMessageCategory = (type: string): "agent" | "tools" | "system" => {
  if (AGENT_TYPES.has(type)) return "agent";
  if (TOOL_TYPES.has(type)) return "tools";
  return "system";
};

const FILTER_KEYS: FilterMode[] = ["all", "agent", "tools", "system"];

const MessageStream = ({
  messages,
  isConnecting,
  scrollToStage,
  isRunning = false,
  elapsed = 0,
  agentProgress,
  engine = "claude",
  currentStage = "",
  worktreePath,
}: MessageStreamProps) => {
  const t = useTranslations("Stream");
  const tc = useTranslations("Common");
  const containerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [stageFilter, setStageFilter] = useState<string>("");
  const [keywordInput, setKeywordInput] = useState<string>("");
  const [keyword, setKeyword] = useState<string>("");
  const [, startTransition] = useTransition();
  const [userScrolled, setUserScrolled] = useState(false);

  // Collect unique stages
  const stages = useMemo(() => {
    const s = new Set<string>();
    for (const m of messages) {
      if (m.stage) s.add(m.stage);
    }
    return Array.from(s);
  }, [messages]);

  // Filter chain: category -> stage -> keyword
  const filtered = useMemo(() => {
    let result = messages;
    if (filter !== "all") {
      result = result.filter((m) => getMessageCategory(m.type) === filter);
    }
    if (stageFilter) {
      result = result.filter((m) => m.stage === stageFilter);
    }
    if (keyword) {
      const kw = keyword.toLowerCase();
      result = result.filter((m) => m.content.toLowerCase().includes(kw));
    }
    return result;
  }, [messages, filter, stageFilter, keyword]);

  // Group messages
  const groups = useMemo(() => groupMessages(filtered), [filtered]);

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  // Detect user scroll up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setUserScrolled(!atBottom);
  }, []);

  // Auto-scroll to bottom when new messages arrive (unless user scrolled up)
  useEffect(() => {
    if (userScrolled || groups.length === 0) return;
    virtualizer.scrollToIndex(groups.length - 1, { align: "end" });
  }, [groups.length, userScrolled, virtualizer]);

  // Scroll to stage when requested
  useEffect(() => {
    if (!scrollToStage) return;
    const idx = groups.findIndex(
      (g) => g.type === "stage_divider" && g.stage === scrollToStage
    );
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "start" });
    }
  }, [scrollToStage, groups, virtualizer]);

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 flex flex-col">
      {/* Filter bar */}
      <div className="flex items-center gap-1 border-b border-zinc-800 px-3 py-1.5 flex-wrap">
        {FILTER_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
              filter === key
                ? "bg-zinc-700 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-400"
            }`}
          >
            {key === "all" ? t("all") : key === "agent" ? t("agentFilter") : key === "tools" ? t("tools") : t("system")}
          </button>
        ))}
        {stages.length > 1 && (
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="ml-2 rounded bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 focus:outline-none"
          >
            <option value="">{t("allStages")}</option>
            {stages.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
        <input
          type="text"
          value={keywordInput}
          onChange={(e) => {
            setKeywordInput(e.target.value);
            startTransition(() => setKeyword(e.target.value));
          }}
          placeholder={tc("search")}
          className="ml-auto rounded bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 w-32"
        />
      </div>

      {/* Virtualized message list */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="max-h-[50vh] overflow-y-auto p-4"
      >
        {groups.length === 0 && isConnecting && (
          <p className="text-sm text-zinc-500">{t("waitingForMessages")}</p>
        )}
        {groups.length === 0 && !isConnecting && messages.length > 0 && (
          <p className="text-sm text-zinc-500">{t("noMessagesMatch")}</p>
        )}
        {groups.length > 0 && (
          <div
            style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const group = groups[virtualItem.index];
              return (
                <div
                  key={group.id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <GroupRenderer group={group} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky status bar */}
      <StatusBar
        isRunning={isRunning}
        currentStage={currentStage}
        elapsed={elapsed}
        toolCallCount={agentProgress?.toolCallCount ?? 0}
        engine={engine}
        phase={agentProgress?.phase}
        thinkingSnippet={agentProgress?.thinkingSnippet}
        worktreePath={worktreePath}
        hasMessages={messages.length > 0}
      />
    </div>
  );
};

export default MessageStream;
export type { DisplayMessage } from "@/lib/types";
