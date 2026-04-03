import { useState } from "react";
import { useTranslations } from "next-intl";
import type { StageCostInfo, StageTokenUsage } from "./stage-timeline";
import { humanizeKey, formatDuration } from "@/lib/utils";

const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

interface CostSummaryProps {
  totalCostUsd: number;
  stageCosts: Record<string, StageCostInfo>;
}

const CostSummary = ({ totalCostUsd, stageCosts }: CostSummaryProps) => {
  const t = useTranslations("Panels");
  const [expanded, setExpanded] = useState(false);
  const [modelExpanded, setModelExpanded] = useState(false);
  const entries = Object.entries(stageCosts);

  if (totalCostUsd === 0 && entries.length === 0) return null;

  // Compute totals across all stages
  const totalTokens = entries.reduce((acc, [, info]) => ({
    input: acc.input + (info.tokenUsage?.inputTokens ?? 0),
    output: acc.output + (info.tokenUsage?.outputTokens ?? 0),
    cacheRead: acc.cacheRead + (info.tokenUsage?.cacheReadTokens ?? 0),
    cacheCreation: acc.cacheCreation + (info.tokenUsage?.cacheCreationTokens ?? 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

  const hasTokenData = totalTokens.input > 0 || totalTokens.output > 0;
  const hasCacheCreation = totalTokens.cacheCreation > 0;

  // Aggregate model breakdown across all stages
  const modelMap = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }>();
  for (const [, info] of entries) {
    for (const m of info.tokenUsage?.modelBreakdown ?? []) {
      const existing = modelMap.get(m.modelName) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
      existing.inputTokens += m.inputTokens;
      existing.outputTokens += m.outputTokens;
      existing.cacheReadTokens += m.cacheReadTokens;
      existing.cacheCreationTokens += m.cacheCreationTokens ?? 0;
      existing.costUsd += m.costUsd ?? 0;
      modelMap.set(m.modelName, existing);
    }
  }
  const hasModelData = modelMap.size > 0;

  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-mono text-zinc-300 hover:bg-zinc-700 transition-colors"
      >
        ${totalCostUsd.toFixed(2)}
        {hasTokenData && (
          <span className="ml-1.5 text-zinc-500">
            {formatTokenCount(totalTokens.input + totalTokens.output)}t
          </span>
        )}
      </button>
      {expanded && entries.length > 0 && (
        <div className="absolute right-0 top-full mt-1 z-20 rounded-md border border-zinc-700 bg-zinc-900 p-3 shadow-xl min-w-[320px] max-h-[70vh] overflow-y-auto">
          {/* Per-stage table */}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left pb-1 font-medium">{t("stage")}</th>
                <th className="text-right pb-1 font-medium">{t("cost")}</th>
                {hasTokenData && (
                  <>
                    <th className="text-right pb-1 font-medium">{t("input")}</th>
                    <th className="text-right pb-1 font-medium">{t("output")}</th>
                    <th className="text-right pb-1 font-medium">{t("cacheRead")}</th>
                    {hasCacheCreation && (
                      <th className="text-right pb-1 font-medium">{t("cacheWrite")}</th>
                    )}
                  </>
                )}
                <th className="text-right pb-1 font-medium">{t("duration")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([stage, info]) => (
                <tr key={stage} className="text-zinc-300">
                  <td className="py-0.5">{humanizeKey(stage)}</td>
                  <td className="text-right font-mono">${info.costUsd.toFixed(3)}</td>
                  {hasTokenData && (
                    <>
                      <td className="text-right font-mono text-zinc-400">{formatTokenCount(info.tokenUsage?.inputTokens ?? 0)}</td>
                      <td className="text-right font-mono text-zinc-400">{formatTokenCount(info.tokenUsage?.outputTokens ?? 0)}</td>
                      <td className="text-right font-mono text-zinc-400">{formatTokenCount(info.tokenUsage?.cacheReadTokens ?? 0)}</td>
                      {hasCacheCreation && (
                        <td className="text-right font-mono text-zinc-400">{formatTokenCount(info.tokenUsage?.cacheCreationTokens ?? 0)}</td>
                      )}
                    </>
                  )}
                  <td className="text-right font-mono">{formatDuration(info.durationMs)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-700 text-zinc-200 font-medium">
                <td className="pt-1">{t("total")}</td>
                <td className="text-right pt-1 font-mono">${totalCostUsd.toFixed(2)}</td>
                {hasTokenData && (
                  <>
                    <td className="text-right pt-1 font-mono">{formatTokenCount(totalTokens.input)}</td>
                    <td className="text-right pt-1 font-mono">{formatTokenCount(totalTokens.output)}</td>
                    <td className="text-right pt-1 font-mono">{formatTokenCount(totalTokens.cacheRead)}</td>
                    {hasCacheCreation && (
                      <td className="text-right pt-1 font-mono">{formatTokenCount(totalTokens.cacheCreation)}</td>
                    )}
                  </>
                )}
                <td />
              </tr>
            </tfoot>
          </table>

          {/* Per-model breakdown (collapsible) */}
          {hasModelData && (
            <div className="mt-3 border-t border-zinc-800 pt-2">
              <button
                onClick={() => setModelExpanded(!modelExpanded)}
                className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {modelExpanded ? "▾" : "▸"} {t("modelBreakdown")}
              </button>
              {modelExpanded && (
                <table className="w-full text-xs mt-1">
                  <thead>
                    <tr className="text-zinc-500">
                      <th className="text-left pb-1 font-medium">{t("model")}</th>
                      <th className="text-right pb-1 font-medium">{t("input")}</th>
                      <th className="text-right pb-1 font-medium">{t("output")}</th>
                      <th className="text-right pb-1 font-medium">{t("cacheRead")}</th>
                      {hasCacheCreation && (
                        <th className="text-right pb-1 font-medium">{t("cacheWrite")}</th>
                      )}
                      <th className="text-right pb-1 font-medium">{t("cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...modelMap.entries()].map(([modelName, m]) => (
                      <tr key={modelName} className="text-zinc-300">
                        <td className="py-0.5 max-w-[120px] truncate" title={modelName}>{modelName}</td>
                        <td className="text-right font-mono text-zinc-400">{formatTokenCount(m.inputTokens)}</td>
                        <td className="text-right font-mono text-zinc-400">{formatTokenCount(m.outputTokens)}</td>
                        <td className="text-right font-mono text-zinc-400">{formatTokenCount(m.cacheReadTokens)}</td>
                        {hasCacheCreation && (
                          <td className="text-right font-mono text-zinc-400">{formatTokenCount(m.cacheCreationTokens)}</td>
                        )}
                        <td className="text-right font-mono">{m.costUsd > 0 ? `$${m.costUsd.toFixed(3)}` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CostSummary;
