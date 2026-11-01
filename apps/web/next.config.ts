import type { NextConfig } from "next";

const config: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_BASE_URL ?? "http://127.0.0.1:3001"}/:path*` }];
  },
};
export default config;
