import type { NextConfig } from "next";

const NOINDEX = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

const nextConfig: NextConfig = {
  // brooker.family/maple proxies to this app; a prefixed asset path is what lets that
  // host forward Maple's scripts and styles (its next.config rewrites /maple-static/*).
  assetPrefix: "/maple-static",
  async headers() {
    return [
      { source: "/maple", headers: NOINDEX },
      { source: "/maple/:path*", headers: NOINDEX },
    ];
  },
};

export default nextConfig;
