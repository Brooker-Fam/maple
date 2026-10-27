import { NextResponse } from "next/server";

export function proxy() {
  if (process.env.MAPLE_READ_ONLY !== "1") return NextResponse.next();
  return NextResponse.json(
    { error: "Maple is briefly offline. Please try again.", code: "offline" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } }
  );
}

export const config = {
  matcher: ["/api/maple/:path*", "/oauth/:path*", "/api/waitlist"],
};
