"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import type { FragmentMeta } from "@/lib/pipeline-types";
import PipelineEditor from "@/components/config/pipeline-editor";
import { useToast } from "@/components/toast";

export interface ConfigWorkbenchProps {
  mode?: "task" | "global";
  taskId?: string;
  config: {
    pipelineName?: string;
    pipeline: any;
    prompts: {
      system: Record<string, string>;
      fragments: Record<string, string>;
      fragmentMeta?: Record<string, FragmentMeta>;
      globalConstraints: string;
      globalClaudeMd: string;
      globalGeminiMd?: string;
      globalCodexMd?: string;
    };
    [key: string]: unknown;
  };
  status?: string;
  onLaunch?: () => void;
  onUpdateConfig: (newConfig: any) => Promise<void>;
  availableMcps?: Array<{ name: string; description: string; available: boolean }>;
}

const TERMINAL_STATES = new Set(["idle", "completed", "error", "cancelled", "blocked"]);

const ConfigWorkbench = ({
  mode = "task",
  taskId,
  config: initialConfig,
  status,
  onLaunch,
  onUpdateConfig,
  availableMcps,
}: ConfigWorkbenchProps) => {
  const t = useTranslations("Config");
  const toast = useToast();
  const [forceEdit, setForceEdit] = useState(false);
  const lastTaskId = useRef(taskId || "global");
  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const isRunning = useMemo(() => {
    if (mode === "global") return false;
    if (forceEdit) return false;
    return status ? !TERMINAL_STATES.has(status) : false;
  }, [status, forceEdit, mode]);

  // Reset on task change
  useEffect(() => {
    const currentId = taskId || "global";
    if (lastTaskId.current !== currentId) {
      lastTaskId.current = currentId;
      setForceEdit(false);
    }
  }, [taskId]);

  // Reset interrupt flag when task becomes terminal
  useEffect(() => {
    if (mode === "global") return;
    if (status && TERMINAL_STATES.has(status)) {
      setForceEdit(false);
    }
  }, [status, mode]);

  const handleInterrupt = async () => {
    if (!taskId) return;
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "User interrupted to edit configuration." }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Interrupt failed (${res.status})`);
      }
      setForceEdit(true);
    } catch (err) {
      console.error("Interrupt failed", err);
      setForceEdit(false);
      toast.error(err instanceof Error ? err.message : t("savingFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Task mode header with status and launch */}
      {mode === "task" && (
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {isRunning && !forceEdit && (
              <>
                <span className="text-[11px] bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded border border-blue-800 animate-pulse uppercase tracking-widest">
                  {t("active")}
                </span>
                <button
                  onClick={handleInterrupt}
                  className="text-[11px] text-red-400 font-medium underline hover:text-red-300 transition-colors"
                >
                  {t("interruptToUnlock")}
                </button>
              </>
            )}
            {forceEdit && (
              <span className="text-[11px] bg-orange-900/30 text-orange-400 px-2 py-0.5 rounded border border-orange-800 animate-pulse uppercase tracking-widest">
                {t("overrideMode")}
              </span>
            )}
          </div>
          {status === "idle" && onLaunch && (
            <button
              onClick={onLaunch}
              className="rounded bg-zinc-100 px-6 py-1.5 text-sm font-bold text-zinc-900 hover:bg-white active:scale-95 shadow-lg shadow-white/5"
            >
              {t("launch")} &rarr;
            </button>
          )}
        </div>
      )}

      <PipelineEditor
        config={initialConfig}
        readOnly={isRunning}
        onSave={onUpdateConfig}
        availableMcps={availableMcps}
      />
    </div>
  );
};

export default ConfigWorkbench;
