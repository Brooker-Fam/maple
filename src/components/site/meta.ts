import type { Metadata } from "next";

/** A child's openGraph replaces the layout's whole object, so every page builds its own from this. */
export function siteOpenGraph(title: string, description: string, url: string): NonNullable<Metadata["openGraph"]> {
  return { type: "website", siteName: "Maple Baby", locale: "en_US", title, description, url };
}
