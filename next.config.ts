import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  serverExternalPackages: [
    "@prisma/client",
    "@modelcontextprotocol/sdk",
    "@google/genai",
  ],
};
export default config;
