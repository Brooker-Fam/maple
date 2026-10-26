import type { MetadataRoute } from "next";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      // The site's scripts, styles and icons share the /maple prefix; the longer allow wins over the app's disallow.
      allow: ["/", "/maple-static/", "/maple-icon"],
      disallow: ["/maple", "/api/", "/oauth/"],
    },
    sitemap: `${MAPLE_ORIGIN}/sitemap.xml`,
  };
}
