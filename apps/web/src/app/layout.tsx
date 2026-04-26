import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { ToastProvider } from "@/components/toast";
import Nav from "@/components/nav";
import ErrorBoundary from "@/components/error-boundary";
import { KeyboardShortcutsOverlay } from "@/components/keyboard-shortcuts-overlay";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workflow Control",
  description: "AI-powered frontend development workflow",
};

// Pre-hydration theme application: read localStorage and apply
// [data-theme="light"|"dark"] on <html> before React hydrates so the
// user never sees a flash of the wrong theme. Falls back to OS pref.
const themeBootstrapScript = `
(function(){try{var s=localStorage.getItem('wfctl-theme');var pref=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';var t=(s==='light'||s==='dark')?s:pref;document.documentElement.dataset.theme=t;}catch(_){document.documentElement.dataset.theme='dark';}})();
`;

const RootLayout = async ({ children }: { children: React.ReactNode }) => {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="min-h-screen bg-page text-primary antialiased">
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>
            <header className="border-b border-default px-6 py-4">
              <Nav />
            </header>
            <main className="mx-auto w-full max-w-[min(1600px,95vw)] px-6 py-6">
              <ErrorBoundary>{children}</ErrorBoundary>
            </main>
            <KeyboardShortcutsOverlay />
          </ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
};

export default RootLayout;
