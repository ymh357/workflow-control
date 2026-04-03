"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import mermaid from "mermaid";

interface MermaidProps {
  chart: string;
}

const Mermaid = ({ chart }: MermaidProps) => {
  const t = useTranslations("Stream");
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Initialize mermaid only on client
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      maxTextSize: 500000,
      themeVariables: {
        primaryColor: "#3b82f6",
        primaryTextColor: "#fff",
        primaryBorderColor: "#1d4ed8",
        lineColor: "#3f3f46",
        secondaryColor: "#1e1b4b",
        tertiaryColor: "#0f172a",
      },
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: "basis",
      },
    });
    setMounted(true);
  }, []);

  useEffect(() => {
    let isMounted = true;
    
    if (mounted && ref.current && chart) {
      const renderChart = async () => {
        try {
          // Generate a unique ID for this render
          const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
          const { svg } = await mermaid.render(id, chart);
          
          if (isMounted && ref.current) {
            ref.current.innerHTML = svg;
          }
        } catch (err) {
          console.error(t("mermaidError"), err);
          if (isMounted && ref.current) {
            ref.current.innerHTML = `<div class="text-red-500 text-[10px] p-4 border border-red-900/30 bg-red-900/10 rounded-lg">
              <strong>${t("diagramError")}</strong><br/>
              ${t("diagramErrorHint")}
            </div>`;
          }
        }
      };

      renderChart();
    }
    
    return () => {
      isMounted = false;
      if (ref.current) ref.current.innerHTML = "";
    };
  }, [chart, mounted, t]);

  if (!mounted) {
    return (
      <div className="flex justify-center bg-zinc-950 p-8 rounded-2xl border border-zinc-800 min-h-[200px] items-center">
        <div className="text-zinc-700 text-xs animate-pulse">{t("initializingDiagram")}</div>
      </div>
    );
  }

  return (
    <div className="flex justify-center bg-zinc-950 p-8 rounded-2xl border border-zinc-800">
      <div ref={ref} className="w-full flex justify-center" />
    </div>
  );
};

export default Mermaid;
