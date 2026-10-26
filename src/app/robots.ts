import type { MetadataRoute } from "next";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";

export default function robots(): MetadataRoute.Robots {
  return {
    // /maple stays crawlable so crawlers can read its noindex; a blocked page can still be listed as a bare URL.
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/oauth/"] },
    sitemap: `${MAPLE_ORIGIN}/sitemap.xml`,
  };
}
