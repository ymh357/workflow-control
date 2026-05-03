"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { usePendingProposalsCount } from "../hooks/use-pending-proposals-count";
import { ThemeToggle } from "./theme-toggle";

const Nav = () => {
  const t = useTranslations("Common");
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const pendingCount = usePendingProposalsCount();

  const switchLocale = (locale: string) => {
    document.cookie = `locale=${locale};path=/;max-age=31536000`;
    router.refresh();
  };

  // 2026-04-27 B1: explicit "/" launcher entry. Tasks remains active for
  // anything under /kernel-next that is not one of the dedicated
  // sub-routes (pipelines / proposals / mcp-catalog).
  // 2026-05-03 (whitepaper review A.1): added mcp-catalog as a top-level
  // entry — the page existed but was unreachable from the nav, users had
  // to memorise the URL. Attempts pages (/kernel-next/attempts/[id]) stay
  // under inTasks because they are entered via deep-link from task detail,
  // not as an independent top-level surface.
  const inLauncher = pathname === "/";
  const inPipelines = pathname.startsWith("/kernel-next/pipelines");
  const inProposals = pathname.startsWith("/kernel-next/proposals");
  const inMcpCatalog = pathname.startsWith("/kernel-next/mcp-catalog");
  const inTasks =
    pathname.startsWith("/kernel-next")
    && !inPipelines && !inProposals && !inMcpCatalog;

  const linkClass = (active: boolean) =>
    active
      ? "rounded px-2 py-1 text-sm font-semibold text-primary bg-elevated"
      : "rounded px-2 py-1 text-sm text-secondary hover:bg-surface hover:text-primary transition-colors";

  return (
    <nav className="flex items-center gap-1">
      <Link
        href="/"
        className="mr-4 text-lg font-semibold text-primary hover:opacity-90"
      >
        {t("appTitle")}
      </Link>
      <Link href="/" className={linkClass(inLauncher)}>
        Launch
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
            className="ml-1.5 inline-block rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-xs font-semibold text-warning-fg"
            aria-label={`${pendingCount} pending proposals`}
          >
            {pendingCount}
          </span>
        )}
      </Link>
      <Link href="/kernel-next/mcp-catalog" className={linkClass(inMcpCatalog)}>
        MCP catalog
      </Link>
      <div className="ml-auto flex items-center gap-1 text-xs">
        <ThemeToggle />
        <span className="text-secondary opacity-30">|</span>
        <button
          onClick={() => switchLocale("en")}
          className="rounded px-2 py-1 text-secondary hover:bg-elevated hover:text-primary transition-colors"
        >
          {t("language.en")}
        </button>
        <span className="text-secondary opacity-30">|</span>
        <button
          onClick={() => switchLocale("zh")}
          className="rounded px-2 py-1 text-secondary hover:bg-elevated hover:text-primary transition-colors"
        >
          {t("language.zh")}
        </button>
      </div>
    </nav>
  );
};

export default Nav;
