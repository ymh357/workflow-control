import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { ToastProvider } from "@/components/toast";
import Nav from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Workflow Control",
  description: "AI-powered frontend development workflow",
};

const RootLayout = async ({ children }: { children: React.ReactNode }) => {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <NextIntlClientProvider messages={messages}>
          <ToastProvider>
            <header className="border-b border-zinc-800 px-6 py-4">
              <Nav />
            </header>
            <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
          </ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
};

export default RootLayout;
