"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { usePendingProposalsCount } from "../hooks/use-pending-proposals-count";

const Nav = () => {
  const t = useTranslations("Common");
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const pendingCount = usePendingProposalsCount();

  const switchLocale = (locale: string) => {
    document.cookie = `locale=${locale};path=/;max-age=31536000`;
    router.refresh();
  };

  // Tasks is active anywhere under /kernel-next that is not the pipelines
  // or proposals subtrees. This covers the list page (/kernel-next) and
  // per-task detail pages (/kernel-next/[taskId]).
  const inPipelines = pathname.startsWith("/kernel-next/pipelines");
  const inProposals = pathname.startsWith("/kernel-next/proposals");
  const inTasks = pathname.startsWith("/kernel-next") && !inPipelines && !inProposals;

  const linkClass = (active: boolean) =>
    active
      ? "rounded px-2 py-1 text-sm font-semibold text-zinc-100 bg-zinc-800"
      : "rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors";

  return (
    <nav className="flex items-center gap-1">
      <Link
        href="/kernel-next"
        className="mr-4 text-lg font-semibold text-zinc-100 hover:text-white"
      >
        {t("appTitle")}
      </Link>
      <Link href="/kernel-next" className={linkClass(inTasks)}>
        {t("nav.tasks")}
      </Link>
      <Link href="/kernel-next/pipelines" className={linkClass(inPipelines)}>
        {t("nav.pipelines")}
      </Link>
      <Link href="/kernel-next/proposals" className={linkClass(inProposals)}>
        {t("nav.proposals")}
        {pendingCount !== null && pendingCount > 0 && (
          <span
            className="ml-1.5 inline-block rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-950"
            aria-label={`${pendingCount} pending proposals`}
          >
            {pendingCount}
          </span>
        )}
      </Link>
      <div className="ml-auto flex items-center gap-1 text-xs">
        <button
          onClick={() => switchLocale("en")}
          className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
        >
          {t("language.en")}
        </button>
        <span className="text-zinc-600">|</span>
        <button
          onClick={() => switchLocale("zh")}
          className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
        >
          {t("language.zh")}
        </button>
      </div>
    </nav>
  );
};

export default Nav;
