import { useTranslations } from "next-intl";

interface StatusBarProps {
  isRunning: boolean;
  currentStage: string;
  elapsed: number;
  toolCallCount: number;
  engine: string;
  phase?: string;
  thinkingSnippet?: string;
  worktreePath?: string;
  hasMessages: boolean;
}

const StatusBar = ({ isRunning, currentStage, elapsed, toolCallCount, engine, phase, thinkingSnippet, worktreePath, hasMessages }: StatusBarProps) => {
  const t = useTranslations("Stream");
  if (!isRunning) return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const isMcpInit = phase === "mcp_init";
  const isLongWait = elapsed > 60;

  const label = isMcpInit
    ? t("initializingMcp")
    : t("workingOn", { stage: currentStage });

  // Full-size hero when no messages yet
  if (!hasMessages) {
    return (
      <div className={`p-4 space-y-2 ${isLongWait ? "border-t border-orange-800 bg-orange-900/20" : "border-t border-zinc-800 bg-zinc-900/30 animate-pulse"}`}>
        <div className="flex items-center gap-3">
          <div className={`h-2 w-2 rounded-full ${isLongWait ? "bg-orange-400" : "bg-yellow-400 animate-ping"}`} />
          <span className="text-sm font-medium text-zinc-300">{label}</span>
          <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border ${
            engine === "gemini"
              ? "text-purple-400 bg-purple-900/20 border-purple-800/50"
              : engine === "codex"
              ? "text-green-400 bg-green-900/20 border-green-800/50"
              : "text-blue-400 bg-blue-900/20 border-blue-800/50"
          }`}>{engine}</span>
          {elapsed > 0 && (
            <span className={`text-xs font-mono ${isLongWait ? "text-orange-400" : "text-zinc-500"}`}>{timeStr}</span>
          )}
          {toolCallCount > 0 && (
            <span className="text-[10px] text-zinc-500">{toolCallCount} {t("toolCalls")}</span>
          )}
        </div>
        {thinkingSnippet && (
          <p className="text-xs text-zinc-500 italic pl-5 truncate">{thinkingSnippet.slice(0, 120)}</p>
        )}
        {worktreePath && (
          <p className="text-xs text-zinc-500 font-mono pl-5">Worktree: {worktreePath}</p>
        )}
        <p className={`text-xs pl-5 ${isLongWait ? "text-orange-400" : "text-zinc-600"}`}>
          {isMcpInit ? t("mcpStarting")
            : isLongWait ? t("mcpSlow")
            : t("waitingForOutput")}
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-400" />
        </span>
        <span className="text-xs text-zinc-300">
          {label}
        </span>
        <span className="text-[10px] text-zinc-500 font-mono">{timeStr}</span>
        {toolCallCount > 0 && (
          <span className="text-[10px] text-zinc-500">{toolCallCount} {t("toolCalls")}</span>
        )}
        <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border ${
          engine === "gemini"
            ? "text-purple-400 bg-purple-900/20 border-purple-800/50"
            : engine === "codex"
            ? "text-green-400 bg-green-900/20 border-green-800/50"
            : "text-blue-400 bg-blue-900/20 border-blue-800/50"
        }`}>
          {engine}
        </span>
        {thinkingSnippet && (
          <span className="text-[10px] italic text-zinc-600 truncate max-w-[200px]">
            {thinkingSnippet.slice(0, 80)}
          </span>
        )}
      </div>
    </div>
  );
};

export default StatusBar;
