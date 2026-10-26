import type { MetadataRoute } from "next";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";
import { LEGAL_UPDATED } from "@/components/site/legal";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${MAPLE_ORIGIN}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${MAPLE_ORIGIN}/privacy`, lastModified: LEGAL_UPDATED, changeFrequency: "yearly", priority: 0.4 },
    { url: `${MAPLE_ORIGIN}/terms`, lastModified: LEGAL_UPDATED, changeFrequency: "yearly", priority: 0.4 },
  ];
}
