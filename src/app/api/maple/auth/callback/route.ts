import type { NextRequest } from "next/server";
import { handleMapleGoogleCallback } from "@/lib/maple/google-callback";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleMapleGoogleCallback(request);
}
