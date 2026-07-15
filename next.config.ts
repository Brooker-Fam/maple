import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let Vercel's image optimizer resize guest photos stored in Blob. The
  // gallery grid uses this for photos that predate client-side thumbnails
  // (thumb_url = null), so tiles never pull the full ~4096px original.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
      { protocol: "https", hostname: "*.blob.vercel-storage.com" },
    ],
  },
  // PostHog reverse proxy — avoids ad-blockers and keeps events on same origin.
  // The /ingest/* paths are proxied to PostHog's ingestion endpoints.
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
      {
        source: "/ingest/decide",
        destination: "https://us.i.posthog.com/decide",
      },
    ];
  },
  // Required for PostHog's trailing-slash handling
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
