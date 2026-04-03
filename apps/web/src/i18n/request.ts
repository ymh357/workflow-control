import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

export default getRequestConfig(async () => {
  const store = await cookies();
  const locale = store.get("locale")?.value || "en";

  return {
    locale,
    messages: {
      Common: (await import(`../messages/${locale}/common.json`)).default,
      Tasks: (await import(`../messages/${locale}/tasks.json`)).default,
      Config: (await import(`../messages/${locale}/config.json`)).default,
      Stream: (await import(`../messages/${locale}/stream.json`)).default,
      Panels: (await import(`../messages/${locale}/panels.json`)).default,
      Registry: (await import(`../messages/${locale}/registry.json`)).default,
    },
  };
});
