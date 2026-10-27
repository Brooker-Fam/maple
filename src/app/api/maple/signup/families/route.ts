import type { NextRequest } from "next/server";
import { listFamilies, switchFamily } from "@/lib/maple/family/switch";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return listFamilies(request);
}

export function POST(request: NextRequest) {
  return switchFamily(request);
}
