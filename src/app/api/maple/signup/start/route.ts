import type { NextRequest } from "next/server";
import { startSignup } from "@/lib/maple/family/signup";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return startSignup(request);
}
