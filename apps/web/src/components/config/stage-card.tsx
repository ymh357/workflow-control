"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { ValidationIssue } from "@/lib/pipeline-validator";

export interface Stage {
  name: string;
  type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach";
  model?: string;
  max_turns?: number;
  max_budget_usd?: number;
  effort?: "low" | "medium" | "high" | "max";
  mcps?: string[];
  runtime?: {
    engine: "llm" | "script" | "human_gate" | "condition" | "pipeline" | "foreach";
    system_prompt?: string;
    writes?: string[];
    reads?: Record<string, string>;
    script_id?: string;
    on_approve_to?: string;
    on_reject_to?: string;
    retry?: { max_retries?: number; back_to?: string };
    [key: string]: unknown;
  };
  outputs?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParallelGroup {
  parallel: {
    name: string;
    stages: Stage[];
  };
}

export type StageEntry = Stage | ParallelGroup;

export function isParallelGroup(entry: StageEntry): entry is ParallelGroup {
  return "parallel" in entry;
}

export function flattenStageEntries(entries: StageEntry[]): Stage[] {
  const result: Stage[] = [];
  for (const e of entries) {
    if (isParallelGroup(e)) {
      result.push(...e.parallel.stages);
    } else {
      result.push(e);
    }
  }
  return result;
}

interface StageCardProps {
  index: number;
  stage: Stage;
  isSelected: boolean;
  issues: ValidationIssue[];
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  isFirst: boolean;
  isLast: boolean;
}

const TYPE_BADGE_COLOR: Record<string, string> = {
  agent: "text-blue-400 bg-blue-900/30 border-blue-800/50",
  human_confirm: "text-purple-400 bg-purple-900/30 border-purple-800/50",
  script: "text-zinc-400 bg-zinc-800 border-zinc-700",
  condition: "text-yellow-400 bg-yellow-900/30 border-yellow-800/50",
  pipeline: "text-green-400 bg-green-900/30 border-green-800/50",
  foreach: "text-orange-400 bg-orange-900/30 border-orange-800/50",
};

const StageCard = ({
  index,
  stage,
  isSelected,
  issues,
  onSelect,
  onMoveUp,
  onMoveDown,
  onRemove,
  isFirst,
  isLast,
}: StageCardProps) => {
  const t = useTranslations("Config");
  const runtime = stage.runtime;
  const TYPE_BADGE_LABEL: Record<string, string> = {
    agent: t("agent"),
    human_confirm: t("gate"),
    script: t("script"),
    condition: t("condition"),
    pipeline: t("pipelineCall"),
    foreach: t("foreach"),
  };
  const badgeColor = TYPE_BADGE_COLOR[stage.type] ?? TYPE_BADGE_COLOR.script;
  const badgeLabel = TYPE_BADGE_LABEL[stage.type] ?? TYPE_BADGE_LABEL.script;
  const writes = runtime?.writes ?? [];
  const reads = runtime?.reads ? Object.values(runtime.reads) : [];
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      className={`group relative w-full text-left rounded-lg border p-3 transition-all cursor-pointer ${
        isSelected
          ? "border-blue-600 bg-blue-950/20 ring-1 ring-blue-600/30"
          : "border-zinc-800 bg-zinc-900/30 hover:border-zinc-700"
      }`}
    >
      {/* Row 1: index, name, type */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-mono text-zinc-600 w-4 shrink-0 text-right">
          {index + 1}
        </span>
        <span className="text-sm font-bold text-zinc-100 truncate">{stage.name}</span>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border shrink-0 ${badgeColor}`}
        >
          {badgeLabel}
        </span>
        {errorCount > 0 && (
          <span className="ml-auto px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-400 text-[10px] font-bold border border-red-800/50 shrink-0">
            {errorCount} err
          </span>
        )}
        {warnCount > 0 && errorCount === 0 && (
          <span className="ml-auto px-1.5 py-0.5 rounded-full bg-amber-900/30 text-amber-400 text-[10px] font-bold border border-amber-800/50 shrink-0">
            {warnCount} warn
          </span>
        )}
      </div>

      {/* Row 2: type-specific details */}
      <div className="ml-6 text-[11px] text-zinc-500 space-y-0.5">
        {/* Data flow for agent/script */}
        {(stage.type === "agent" || stage.type === "script") && (
          <div className="flex items-center gap-1.5">
            {reads.length > 0 && (
              <>
                <span className="text-zinc-600">{t("readsLabel")}</span>
                <span className="text-zinc-400 truncate max-w-[120px]">{reads.join(", ")}</span>
                <span className="text-zinc-700 mx-0.5">&rarr;</span>
              </>
            )}
            {writes.length > 0 && (
              <>
                <span className="text-zinc-600">{t("writesLabel")}</span>
                <span className="text-zinc-400 truncate max-w-[120px]">{writes.join(", ")}</span>
              </>
            )}
            {reads.length === 0 && writes.length === 0 && (
              <span className="italic text-zinc-600">{t("noDataFlow")}</span>
            )}
          </div>
        )}

        {/* Condition: branch routing */}
        {stage.type === "condition" && (() => {
          const branches = (runtime as any)?.branches as Array<{ when?: string; default?: boolean; to?: string }> | undefined;
          if (!branches?.length) return <div className="italic text-zinc-600">0 {t("branches")}</div>;
          return (
            <div className="space-y-px">
              {branches.map((b, bi) => {
                const label = b.default ? "default" : (b.when ?? "?");
                const trunc = label.length > 18 ? label.slice(0, 18) + "..." : label;
                return (
                  <div key={bi} className="flex items-center gap-1 text-[10px]">
                    <span className="text-yellow-600 shrink-0">&rarr;</span>
                    <span className="text-yellow-400/60 truncate max-w-[130px]">{trunc}</span>
                    <span className="text-zinc-700">&rarr;</span>
                    <span className="text-zinc-300 font-medium">{b.to ?? "next"}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Gate: reject target + feedback loops */}
        {stage.type === "human_confirm" && (
          <div className="space-y-px">
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-red-500/70 shrink-0">reject &rarr;</span>
              <span className="text-zinc-400">{runtime?.on_reject_to && runtime.on_reject_to !== "error" ? runtime.on_reject_to : "error"}</span>
            </div>
            {(runtime as any)?.max_feedback_loops != null && (
              <div className="text-[10px] text-zinc-600">
                max {(runtime as any).max_feedback_loops} feedback loops
              </div>
            )}
          </div>
        )}

        {/* Pipeline: sub-pipeline + reads/writes mapping */}
        {stage.type === "pipeline" && (
          <div className="space-y-px">
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-green-500/70 shrink-0">&rarr;</span>
              <span className="text-green-400/80 font-medium">{(runtime as any)?.pipeline_name ?? "—"}</span>
            </div>
            {reads.length > 0 && (
              <div className="text-[10px] text-zinc-600">
                reads: {reads.join(", ")}
              </div>
            )}
          </div>
        )}

        {/* Foreach: items, pipeline, concurrency, error mode */}
        {stage.type === "foreach" && (() => {
          const rt = runtime as any;
          return (
            <div className="space-y-px">
              <div className="flex items-center gap-1 text-[10px]">
                <span className="text-orange-500/70 shrink-0">{rt?.items ?? "?"}</span>
                <span className="text-zinc-700">&rarr;</span>
                <span className="text-orange-400/80 font-medium">{rt?.pipeline_name ?? "—"}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                {rt?.max_concurrency && <span>x{rt.max_concurrency}</span>}
                {rt?.on_item_error && <span>[{rt.on_item_error}]</span>}
                {rt?.collect_to && <span>&rarr; {rt.collect_to}</span>}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Row 3: budget + turns (agent/script only) */}
      {(stage.max_budget_usd || stage.max_turns) && (
        <div className="flex items-center gap-3 ml-6 mt-1 text-[11px] text-zinc-600">
          {stage.max_budget_usd != null && (
            <span>${stage.max_budget_usd}</span>
          )}
          {stage.max_turns != null && (
            <span>{stage.max_turns} turns</span>
          )}
          {stage.effort && (
            <span className="text-zinc-700">{stage.effort}</span>
          )}
        </div>
      )}

      {/* Hover actions */}
      <div className="absolute right-2 top-2 hidden group-hover:flex items-center gap-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
          disabled={isFirst}
          className="p-1 text-zinc-600 hover:text-zinc-300 disabled:opacity-20"
          title={t("moveUp")}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
          disabled={isLast}
          className="p-1 text-zinc-600 hover:text-zinc-300 disabled:opacity-20"
          title={t("moveDown")}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="p-1 text-zinc-600 hover:text-red-400"
          title={t("removeStage")}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

// --- Parallel Group Card ---

interface ParallelGroupCardProps {
  index: number;
  group: ParallelGroup;
  isSelected: boolean;
  selectedChildIndex?: number;
  issues: ValidationIssue[];
  onSelectGroup: () => void;
  onSelectChild: (childIndex: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onRemoveChild: (childIndex: number) => void;
  onAddChild?: () => void;
  onDissolve?: () => void;
  onMoveChildUp?: (childIndex: number) => void;
  onMoveChildDown?: (childIndex: number) => void;
  isFirst: boolean;
  isLast: boolean;
  readOnly?: boolean;
}

export const ParallelGroupCard = ({
  index,
  group,
  isSelected,
  selectedChildIndex,
  issues,
  onSelectGroup,
  onSelectChild,
  onMoveUp,
  onMoveDown,
  onRemove,
  onRemoveChild,
  onAddChild,
  onDissolve,
  onMoveChildUp,
  onMoveChildDown,
  isFirst,
  isLast,
  readOnly,
}: ParallelGroupCardProps) => {
  const t = useTranslations("Config");
  const errorCount = issues.filter((i) => i.severity === "error").length;

  return (
    <div
      className={`relative rounded-lg border-2 border-dashed transition-all ${
        isSelected && selectedChildIndex === undefined
          ? "border-emerald-600 bg-emerald-950/10"
          : "border-zinc-700 bg-zinc-900/20"
      }`}
    >
      {/* Group header */}
      <div
        role="button"
        tabIndex={0}
        onClick={onSelectGroup}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectGroup(); } }}
        className="group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800/30 rounded-t-lg"
      >
        <span className="text-[11px] font-mono text-zinc-600 w-4 shrink-0 text-right">{index + 1}</span>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border shrink-0 text-emerald-400 bg-emerald-900/30 border-emerald-800/50">
          parallel
        </span>
        <span className="text-sm font-bold text-zinc-100 truncate">{group.parallel.name}</span>
        <span className="text-[11px] text-zinc-600">{group.parallel.stages.length} stages</span>
        {errorCount > 0 && (
          <span className="ml-auto px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-400 text-[10px] font-bold border border-red-800/50 shrink-0">
            {errorCount} err
          </span>
        )}
        {/* Hover actions */}
        <div className="ml-auto hidden group-hover:flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={(e) => { e.stopPropagation(); onMoveUp(); }} disabled={isFirst} className="p-1 text-zinc-600 hover:text-zinc-300 disabled:opacity-20" title={t("moveUp")}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onMoveDown(); }} disabled={isLast} className="p-1 text-zinc-600 hover:text-zinc-300 disabled:opacity-20" title={t("moveDown")}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
          {!readOnly && onDissolve && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onDissolve(); }} className="p-1 text-zinc-600 hover:text-amber-400" title="Dissolve group">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
            </button>
          )}
          <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="p-1 text-zinc-600 hover:text-red-400" title={t("removeStage")}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {/* Child stages with left border indicator */}
      <div className="border-l-2 border-emerald-800/40 ml-5 pl-2 pb-2 space-y-1">
        {group.parallel.stages.map((child, ci) => (
          <StageCard
            key={`${ci}-${child.name}`}
            index={ci}
            stage={child}
            isSelected={isSelected && selectedChildIndex === ci}
            issues={issues.filter((iss) => iss.field?.startsWith(`child:${ci}:`) || (iss.stageIndex === ci))}
            onSelect={() => onSelectChild(ci)}
            onMoveUp={() => onMoveChildUp?.(ci)}
            onMoveDown={() => onMoveChildDown?.(ci)}
            onRemove={() => onRemoveChild(ci)}
            isFirst={ci === 0}
            isLast={ci === group.parallel.stages.length - 1}
          />
        ))}
        {!readOnly && onAddChild && (
          <button
            type="button"
            onClick={onAddChild}
            className="w-full rounded border border-dashed border-zinc-700 py-1 text-[11px] text-zinc-600 hover:border-zinc-500 hover:text-zinc-400 transition-colors"
          >
            {t("addChildStage")}
          </button>
        )}
      </div>
    </div>
  );
};

export default StageCard;
