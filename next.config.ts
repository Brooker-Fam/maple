import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // brooker.family/maple proxies to this app; a prefixed asset path is what lets that
  // host forward Maple's scripts and styles (its next.config rewrites /maple-static/*).
  assetPrefix: "/maple-static",
};

export default nextConfig;
