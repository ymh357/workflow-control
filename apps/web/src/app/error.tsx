"use client";

import { useTranslations } from "next-intl";

const ErrorPage = ({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) => {
  const t = useTranslations("Common");

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center space-y-4 text-center">
      <h2 className="text-lg font-semibold text-danger-fg">{t("error.somethingWentWrong")}</h2>
      <p className="max-w-md text-sm text-secondary">
        {error.message || t("error.unexpectedError")}
      </p>
      <button
        onClick={reset}
        className="rounded bg-elevated px-4 py-2 text-sm text-primary hover:bg-elevated"
      >
        {t("error.tryAgain")}
      </button>
    </div>
  );
};

export default ErrorPage;
