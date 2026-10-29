import { NextRequest } from "next/server";
import { captureServerException } from "@/lib/posthog-server";
import { query } from "@/lib/db";
import { deleteAbandonedFamilies } from "@/lib/maple/family/cleanup";
import { cleanupExpired as cleanupEpicReviews } from "@/lib/maple/epic/store";
import { errCode, runPushTick } from "@/lib/maple/push";
import { schedulerMode, verifyQstash, wakeFamily, type Via } from "@/lib/maple/push-wake";

/**
 * Send whatever notifications are due (src/lib/maple/push.ts), then re-arm
 * the exact-time wake-ups (push-wake.ts).
 *
 * Who calls it:
 *   - QStash, at the exact moments (a signed request, X-Maple-Via: wake,
 *     retry or test) and on its safety-net schedule (net);
 *   - a cron with Authorization: Bearer $CRON_SECRET (via=daily);
 *   - the GitHub workflow (.github/workflows/maple-reminders.yml, via=gh), a
 *     best-effort backstop every 5 minutes; once QStash is the clock, only
 *     its runs near :04 and :34 (the safety net's minutes) do anything;
 *   - anyone else. That's safe: it only sends what's due, each once, and an
 *     unsigned call runs at most once per 20 seconds (none at all once
 *     QStash is the clock).
 * A signed or cron call skips the 20-second gate. Everyone gets 204 and no
 * body (a count would tell an outsider when her medicines come up); a
 * trusted call that fails gets 500, so QStash retries it.
 *
 * Families: a signed wake, retry or test ticks only the family its signed
 * body names (none: family 1, as wakes from before families do); the
 * safety net, the cron and everyone else sweep the families with a phone on
 * (push.ts). Nothing unsigned can pick a family. A signed call's kind comes
 * from its body (the signature covers it, not X-Maple-Via), so a schedule
 * made without the forwarded header still sweeps every family.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TRUSTED_VIAS: Via[] = ["wake", "net", "daily", "retry", "test"];
/** Runs for one family's moments; the others walk every family. */
const FAMILY_VIAS: Via[] = ["wake", "retry", "test"];

/** A bad signature is reported once per 10 minutes per instance: anyone can send one. */
let lastRejected = 0;
const REJECT_REPORT_MS = 10 * 60_000;

/** The kind a signed body names (wakes and the safety net both carry one), or null. */
function bodyVia(raw: string): Via | null {
  try {
    const via = (JSON.parse(raw || "{}") as { via?: unknown } | null)?.via;
    return typeof via === "string" && TRUSTED_VIAS.includes(via as Via) ? (via as Via) : null;
  } catch {
    return null;
  }
}

/** The GitHub backstop's runs that do something once QStash is the clock (its safety net's minutes, :04 and :34). */
function ghUseful(now: Date): boolean {
  if (schedulerMode() !== "qstash") return true;
  const m = now.getUTCMinutes() % 30;
  return m >= 4 && m < 9;
}

async function handle(request: NextRequest): Promise<Response> {
  const raw = request.method === "POST" ? await request.text().catch(() => "") : "";
  const signature = request.headers.get("upstash-signature");
  const signed = verifyQstash(signature, raw);
  if (signature && !signed && Date.now() - lastRejected > REJECT_REPORT_MS) {
    lastRejected = Date.now();
    void captureServerException(new Error("qstash signature rejected"), { route: "/api/maple/push/tick" });
  }
  const secret = process.env.CRON_SECRET;
  const cron = !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
  const trusted = signed || cron;
  const asked = (request.headers.get("x-maple-via") ?? new URL(request.url).searchParams.get("via") ?? "").toLowerCase() as Via;
  const signedAs = signed ? bodyVia(raw) : null;
  const via: Via = trusted ? (signedAs ?? (TRUSTED_VIAS.includes(asked) ? asked : signed ? "wake" : "daily")) : asked === "gh" ? "gh" : "ext";
  // Every 5 minutes without QStash, as before; with it, only beside the safety net, so the database can sleep.
  if (via === "gh" && !ghUseful(new Date())) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  // With QStash as the clock an outside call adds nothing, and each one would walk every family.
  if (via === "ext" && schedulerMode() === "qstash") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  const familyId = signed && FAMILY_VIAS.includes(via) ? wakeFamily(raw) : undefined;
  if (familyId === null) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  try {
    await runPushTick(new Date(), { via, trusted, schedule: true, familyId });
    if (trusted && (via === "net" || via === "daily")) await dailyCleanup(new Date());
  } catch (err) {
    void captureServerException(new Error(errCode(err)), { route: "/api/maple/push/tick" });
    if (trusted) return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/** Once a day, on a trusted scheduled run: families abandoned during onboarding go (family/cleanup.ts). */
async function dailyCleanup(now: Date): Promise<void> {
  const claimed = await query(`INSERT INTO maple_push_sent (key, sent_at) VALUES ($1, NOW()) ON CONFLICT (key) DO NOTHING RETURNING key`, [
    `cleanup:${now.toISOString().slice(0, 10)}`,
  ]);
  if (claimed?.length) {
    await cleanupEpicReviews();
    await deleteAbandonedFamilies(now);
  }
}

export { handle as GET, handle as POST };
