import { NextResponse } from "next/server";
import { clearSessionCookies } from "@/lib/maple/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  clearSessionCookies(res);
  // Baby photos are cached privately for a year; drop them from this browser.
  res.headers.set("Clear-Site-Data", '"cache"');
  return res;
}
