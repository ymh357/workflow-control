"use client";

import React, { useState } from "react";
import { useTranslations } from "next-intl";
import type { ValidationIssue } from "@/lib/pipeline-validator";
import { getIssueSummary } from "@/lib/pipeline-validator";

interface ValidationBarProps {
  issues: ValidationIssue[];
  stageNames: string[];
  onJumpToStage?: (index: number) => void;
}

const SEVERITY_STYLE = {
  error: "text-red-400",
  warning: "text-amber-400",
  info: "text-blue-400",
};

const ValidationBar = ({ issues, stageNames, onJumpToStage }: ValidationBarProps) => {
  const t = useTranslations("Config");
  const [expanded, setExpanded] = useState(false);
  const summary = getIssueSummary(issues);
  const hasIssues = issues.length > 0;

  if (!hasIssues) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 border-t border-zinc-800 bg-zinc-900/50 text-xs text-zinc-600">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        {t("noIssues")}
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 w-full px-4 py-2 text-xs hover:bg-zinc-800/30 transition-colors"
      >
        <span className="flex items-center gap-2">
          {summary.errors > 0 && (
            <span className="text-red-400 font-bold">{summary.errors} error{summary.errors > 1 ? "s" : ""}</span>
          )}
          {summary.warnings > 0 && (
            <span className="text-amber-400 font-bold">{summary.warnings} warning{summary.warnings > 1 ? "s" : ""}</span>
          )}
          {summary.infos > 0 && (
            <span className="text-blue-400">{summary.infos} info</span>
          )}
        </span>
        <svg
          className={`w-3 h-3 text-zinc-500 transition-transform ml-auto ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>

      {expanded && (
        <div className="max-h-48 overflow-y-auto border-t border-zinc-800/50">
          {issues.map((issue, i) => (
            <div
              key={i}
              className="flex items-start gap-2 px-4 py-2 text-xs border-b border-zinc-800/30 last:border-0"
            >
              <span className={`shrink-0 mt-0.5 font-bold uppercase text-[10px] ${SEVERITY_STYLE[issue.severity]}`}>
                {issue.severity === "error" ? "ERR" : issue.severity === "warning" ? "WARN" : "INFO"}
              </span>
              <span className="text-zinc-400 flex-1">{issue.message}</span>
              {issue.stageIndex != null && onJumpToStage && (
                <button
                  type="button"
                  onClick={() => onJumpToStage(issue.stageIndex!)}
                  className="text-blue-400 hover:text-blue-300 shrink-0 underline"
                >
                  {stageNames[issue.stageIndex] ?? `#${issue.stageIndex + 1}`}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ValidationBar;
