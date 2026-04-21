"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

const Nav = () => {
  const t = useTranslations("Common");
  const router = useRouter();

  const switchLocale = (locale: string) => {
    document.cookie = `locale=${locale};path=/;max-age=31536000`;
    router.refresh();
  };

  return (
    <nav className="flex items-center gap-6">
      <h1 className="text-lg font-semibold">{t("appTitle")}</h1>
      <a href="/" className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
        {t("nav.tasks")}
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
