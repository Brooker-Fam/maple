"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { captureSitePage } from "@/lib/analytics/client";

export default function SiteAnalytics() {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    captureSitePage(pathname);
  }, [pathname]);
  return null;
}
