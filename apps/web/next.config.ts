import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  transpilePackages: ["@workflow-control/shared"],
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
