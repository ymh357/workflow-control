"use client";

import { useState, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Mermaid from "@/components/mermaid";

type PageId = "overview" | "tasks" | "pipelines" | "prompts" | "edge" | "integrations" | "store" | "architecture";

const PAGE_IDS: PageId[] = ["overview", "tasks", "pipelines", "prompts", "edge", "integrations", "store", "architecture"];

const HelpPage = () => {
  const t = useTranslations("Common");
  const locale = useLocale();
  const [page, setPage] = useState<PageId>("overview");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent("");

    const load = async () => {
      let text = "";
      try {
        const res = await window.fetch(`/help/${locale}/${page}.md`);
        if (res.ok) text = await res.text();
      } catch { /* ignore */ }
      if (!text) {
        try {
          const res = await window.fetch(`/help/en/${page}.md`);
          if (res.ok) text = await res.text();
        } catch { /* ignore */ }
      }
      if (cancelled) return;
      setContent(text || "# Content not found");
      setLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [page, locale]);

  const navigate = (id: PageId) => {
    setPage(id);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  const navItems = PAGE_IDS.map((id) => ({
    id,
    label: t(`helpNav.${id}`),
    subtitle: t(`helpNav.${id}Sub`),
  }));

  const idx = PAGE_IDS.indexOf(page);
  const prev = idx > 0 ? PAGE_IDS[idx - 1] : null;
  const next = idx < PAGE_IDS.length - 1 ? PAGE_IDS[idx + 1] : null;

  return (
    <div>
      <nav className="flex gap-1 mb-10 border-b border-zinc-800 pb-px overflow-x-auto">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(item.id)}
            className={`px-5 py-3 text-xs font-medium transition-all relative whitespace-nowrap ${
              page === item.id
                ? "text-blue-400"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <span>{item.label}</span>
            <span className={`ml-1.5 ${page === item.id ? "text-blue-500/60" : "text-zinc-600"}`}>
              {item.subtitle}
            </span>
            {page === item.id && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
            )}
          </button>
        ))}
      </nav>

      <div className="animate-in fade-in duration-300" key={`${page}-${locale}`}>
        {loading ? (
          <div className="flex h-96 items-center justify-center text-zinc-500 animate-pulse">
            {t("loading")}
          </div>
        ) : (
          <div className="max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-3">{children}</h1>,
                h2: ({ children }) => <h2 className="text-2xl font-bold text-zinc-100 tracking-tight mb-4 mt-10">{children}</h2>,
                h3: ({ children }) => <h3 className="text-lg font-semibold text-zinc-200 mb-3 mt-8">{children}</h3>,
                p: ({ children }) => <p className="text-sm text-zinc-400 leading-relaxed mb-4">{children}</p>,
                a: ({ href, children }) => <a href={href} className="text-blue-400 underline hover:text-blue-300">{children}</a>,
                strong: ({ children }) => <strong className="text-zinc-200">{children}</strong>,
                ul: ({ children }) => <ul className="list-disc list-inside space-y-1 mb-4 text-sm text-zinc-400">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-4 text-sm text-zinc-400">{children}</ol>,
                li: ({ children }) => <li className="text-sm text-zinc-400">{children}</li>,
                blockquote: ({ children }) => <blockquote className="border-l-2 border-zinc-700 pl-4 my-4 text-sm text-zinc-400">{children}</blockquote>,
                table: ({ children }) => (
                  <div className="rounded-xl border border-zinc-800 overflow-hidden mb-5">
                    <table className="w-full text-xs">{children}</table>
                  </div>
                ),
                thead: ({ children }) => <thead className="bg-zinc-900/60">{children}</thead>,
                th: ({ children }) => <th className="text-left px-4 py-2.5 text-zinc-400 font-semibold uppercase tracking-wider text-[10px]">{children}</th>,
                td: ({ children }) => <td className="px-4 py-2.5 text-zinc-400 text-xs">{children}</td>,
                tr: ({ children }) => <tr className="border-t border-zinc-800/60 hover:bg-zinc-900/30 transition-colors">{children}</tr>,
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const lang = match?.[1];
                  if (lang === "mermaid") {
                    return <Mermaid chart={String(children).trim()} />;
                  }
                  if (match) {
                    return (
                      <pre className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-400 leading-relaxed font-mono mb-5">
                        <code>{children}</code>
                      </pre>
                    );
                  }
                  return <code className="text-blue-400 bg-blue-950/30 px-1.5 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
                },
                pre({ children }) {
                  return <>{children}</>;
                },
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}

        {/* Page navigation */}
        <div className="flex justify-between items-center mt-12 pt-6 border-t border-zinc-800">
          {prev ? (
            <button onClick={() => navigate(prev)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              <span className="text-zinc-600 mr-1">&larr;</span> {navItems.find(n => n.id === prev)?.label}
            </button>
          ) : <div />}
          {next ? (
            <button onClick={() => navigate(next)} className="text-xs text-blue-500 hover:text-blue-400 transition-colors">
              {navItems.find(n => n.id === next)?.label} <span className="ml-1">&rarr;</span>
            </button>
          ) : <div />}
        </div>
      </div>
    </div>
  );
};

export default HelpPage;
