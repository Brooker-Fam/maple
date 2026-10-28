import type { NextRequest } from "next/server";
import { finishApple } from "@/lib/maple/apple-flow";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) { return finishApple(request); }
