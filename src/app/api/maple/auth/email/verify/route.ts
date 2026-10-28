import type { NextRequest } from "next/server";
import { finishEmail } from "@/lib/maple/email-flow";
export const dynamic = "force-dynamic";
export function POST(request: NextRequest) { return finishEmail(request); }
