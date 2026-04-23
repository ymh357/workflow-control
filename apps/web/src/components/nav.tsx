"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { usePendingProposalsCount } from "../hooks/use-pending-proposals-count";

const Nav = () => {
  const t = useTranslations("Common");
  const router = useRouter();
  const pendingCount = usePendingProposalsCount();

  const switchLocale = (locale: string) => {
    document.cookie = `locale=${locale};path=/;max-age=31536000`;
    router.refresh();
  };

  const linkClass = "text-sm text-zinc-400 hover:text-zinc-200 transition-colors";

  return (
    <nav className="flex items-center gap-6">
      <h1 className="text-lg font-semibold">{t("appTitle")}</h1>
      <a href="/" className={linkClass}>{t("nav.tasks")}</a>
      <a href="/kernel-next/pipelines" className={linkClass}>{t("nav.pipelines")}</a>
      <a href="/kernel-next/proposals" className={linkClass}>
        {t("nav.proposals")}
        {pendingCount !== null && pendingCount > 0 && (
          <span
            className="ml-1 inline-block rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
            aria-label={`${pendingCount} pending proposals`}
          >
            {pendingCount}
          </span>
        )}
      </a>
      <div className="ml-auto flex items-center gap-1 text-xs">
        <button
          onClick={() => switchLocale("en")}
          className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {t("language.en")}
        </button>
        <span className="text-zinc-600">|</span>
        <button
          onClick={() => switchLocale("zh")}
          className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {t("language.zh")}
        </button>
      </div>
    </nav>
  );
};

export default Nav;
