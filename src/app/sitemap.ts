import type { MetadataRoute } from "next";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";
import { LEGAL_UPDATED } from "@/components/site/legal";
import { publishedPosts } from "@/lib/blog";
import { ABOUT_DRAFT } from "./(site)/about/draft";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = publishedPosts();
  return [
    { url: `${MAPLE_ORIGIN}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${MAPLE_ORIGIN}/pricing`, changeFrequency: "monthly", priority: 0.6 },
    ...(ABOUT_DRAFT ? [] : [{ url: `${MAPLE_ORIGIN}/about`, changeFrequency: "monthly" as const, priority: 0.6 }]),
    { url: `${MAPLE_ORIGIN}/faq`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${MAPLE_ORIGIN}/blog`, lastModified: posts[0]?.date, changeFrequency: "weekly", priority: 0.6 },
    ...posts.map((p) => ({ url: `${MAPLE_ORIGIN}/blog/${p.slug}`, lastModified: p.date, changeFrequency: "yearly" as const, priority: 0.5 })),
    { url: `${MAPLE_ORIGIN}/privacy`, lastModified: LEGAL_UPDATED, changeFrequency: "yearly", priority: 0.4 },
    { url: `${MAPLE_ORIGIN}/terms`, lastModified: LEGAL_UPDATED, changeFrequency: "yearly", priority: 0.4 },
  ];
}
