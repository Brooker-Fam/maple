"use client";

import Link from "next/link";
import { captureSiteEvent } from "@/lib/analytics/client";
import { SIGNUP_PATH } from "./paths";

export default function GetStarted({ size = "large", className = "", placement = "other" }: { size?: "small" | "large" | "text"; className?: string; placement?: "header" | "hero" | "footer" | "pricing" | "other" }) {
  return (
    <Link
      href={SIGNUP_PATH}
      prefetch={false}
      onClick={() => captureSiteEvent("signup_clicked", { placement })}
      className={size === "text" ? className : `site-button ${size === "small" ? "site-button-sm" : ""} inline-flex items-center justify-center whitespace-nowrap ${className}`}
    >
      Get started
    </Link>
  );
}
