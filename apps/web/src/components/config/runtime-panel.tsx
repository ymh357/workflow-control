"use client";

import React from "react";
import { useTranslations } from "next-intl";
import SandboxPanel from "./sandbox-panel";
import type { SandboxConfig } from "./sandbox-panel";

interface RuntimePanelProps {
  engine?: "claude" | "gemini" | "codex";
  onEngineChange: (engine: "claude" | "gemini" | "codex") => void;
  agent?: {
    claude_model?: string;
    gemini_model?: string;
  };
  sandbox: SandboxConfig;
  onSandboxChange: (config: SandboxConfig) => void;
  readOnly?: boolean;
  description?: string;
}

const RuntimePanel = ({
  engine = "claude",
  onEngineChange,
  agent,
  sandbox,
  onSandboxChange,
  readOnly = false,
  description
}: RuntimePanelProps) => {
  const t = useTranslations("Config");
  const currentModel = engine === "claude"
    ? (agent?.claude_model || "claude-sonnet-4-20250514")
    : engine === "codex"
    ? "codex"
    : (agent?.gemini_model || "auto");

  return (
    <div className="flex flex-col gap-6">
      {/* Engine Selection */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 shadow-sm">
        <div className="mb-6">
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            {t("executionEngine")}
            <span className="text-[11px] bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded border border-blue-800 uppercase tracking-widest">{t("runtime")}</span>
          </h3>
          <p className="text-xs text-zinc-500 mt-1">Select the default model and CLI runner for this task's stages.</p>
          <span className="text-[11px] text-zinc-600 font-mono mt-0.5 block">{t("currentModel")} {currentModel}</span>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <button
            onClick={() => onEngineChange("claude")}
            disabled={readOnly}
            className={`flex flex-col gap-2 p-4 rounded-xl border transition-all text-left ${
              engine === "claude"
                ? "bg-orange-950/20 border-orange-500/50 ring-1 ring-orange-500/20"
                : "bg-zinc-950/50 border-zinc-800 hover:border-zinc-700 opacity-60"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold ${engine === "claude" ? "text-orange-400" : "text-zinc-400"}`}>{t("claudeCode")}</span>
              {engine === "claude" && <span className="h-2 w-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.5)]" />}
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">{t("claudeCodeDesc")}</p>
          </button>

          <button
            onClick={() => onEngineChange("gemini")}
            disabled={readOnly}
            className={`flex flex-col gap-2 p-4 rounded-xl border transition-all text-left ${
              engine === "gemini"
                ? "bg-blue-950/20 border-blue-500/50 ring-1 ring-blue-500/20"
                : "bg-zinc-950/50 border-zinc-800 hover:border-zinc-700 opacity-60"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold ${engine === "gemini" ? "text-blue-400" : "text-zinc-400"}`}>{t("geminiCli")}</span>
              {engine === "gemini" && <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />}
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">{t("geminiCliDesc")}</p>
          </button>

          <button
            onClick={() => onEngineChange("codex")}
            disabled={readOnly}
            className={`flex flex-col gap-2 p-4 rounded-xl border transition-all text-left ${
              engine === "codex"
                ? "bg-green-950/20 border-green-500/50 ring-1 ring-green-500/20"
                : "bg-zinc-950/50 border-zinc-800 hover:border-zinc-700 opacity-60"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold ${engine === "codex" ? "text-green-400" : "text-zinc-400"}`}>Codex</span>
              {engine === "codex" && <span className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />}
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">OpenAI Codex CLI agent</p>
          </button>
        </div>
      </div>

      {/* Sandbox — reuse SandboxPanel instead of duplicating */}
      <SandboxPanel
        value={sandbox}
        onChange={onSandboxChange}
        readOnly={readOnly}
        description={description}
      />
    </div>
  );
};

export default RuntimePanel;
