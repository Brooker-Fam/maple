import type { NextRequest } from "next/server";
import { startEmail } from "@/lib/maple/email-flow";
export const dynamic = "force-dynamic";
export function POST(request: NextRequest) { return startEmail(request); }
