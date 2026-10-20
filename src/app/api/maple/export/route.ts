import { NextResponse } from "next/server";
import { listMembers } from "@/lib/maple/auth";
import { withMember } from "@/lib/maple/api";
import { describeEntry } from "@/lib/maple/describe";
import { memberName } from "@/lib/maple/insights";
import { getBaby, listEntries, toClientEntry } from "@/lib/maple/store";
import { dayKey, formatTime } from "@/lib/maple/time";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Neutralize spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** GET /api/maple/export — every entry as CSV, oldest first (for the pediatrician or a backup). */
export const GET = withMember("GET /api/maple/export", async () => {
  const baby = await getBaby();
  const members = await listMembers();
  // Page through everything (a busy year is well over one page).
  const entries = [];
  for (let after: { startedAt: string; id: number } | undefined; ; ) {
    const page = await listEntries({ babyId: baby.id, ascending: true, limit: 5000, after });
    entries.push(...page);
    if (page.length < 5000) break;
    const last = page[page.length - 1];
    after = { startedAt: last.started_at, id: last.id };
  }
  const tz = baby.timezone;
  const header = ["id", "date", "start", "end", "minutes", "kind", "summary", "note", "logged_by", "via", "data_json"];
  const lines = [header.map(csvCell).join(",")];
  for (const raw of entries) {
    const e = toClientEntry(raw);
    const start = new Date(e.started_at);
    const end = e.ended_at ? new Date(e.ended_at) : null;
    const d = describeEntry(e, { units: "us" });
    lines.push(
      [
        e.id,
        dayKey(start, tz),
        formatTime(start, tz),
        end ? formatTime(end, tz) : "",
        end ? Math.round((end.getTime() - start.getTime()) / 60000) : "",
        e.kind,
        [d.title, d.detail].filter(Boolean).join(" · "),
        e.note ?? "",
        memberName(e.created_by, members),
        e.source,
        JSON.stringify(e.data),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  const name = `${(baby.nickname || baby.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-log-${dayKey(new Date(), tz)}.csv`;
  return new NextResponse(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
});
