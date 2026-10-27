import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MIN, type Entry, type Kind, type Sim } from "./sim";

/** Results shaped like mcp-tools.ts's: one sentence (or a few lines), then compact JSON. */

export type Args = Record<string, unknown>;
export type Handler = (a: Args, sim: Sim) => CallToolResult;

export function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: `${summary}\n${JSON.stringify(data)}` }], structuredContent: { summary, ...data } };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

const VIA = "Maple chat";

export function savedLine(sim: Sim, e: Entry): string {
  return `Saved #${e.id}: ${sim.phrase(e)} at ${sim.whenText(e.start)} (logged by ${e.by} via ${e.via === "chat" ? VIA : e.via}).`;
}

export function entryJson(sim: Sim, e: Entry): Record<string, unknown> {
  return { id: e.id, kind: e.kind === "med" ? "medicine" : e.kind, local: sim.whenText(e.start), ...(e.end && !e.active ? { ended_local: sim.whenText(e.end) } : {}), summary: sim.phrase(e), by: e.by, via: e.via };
}

const stable = (v: unknown) => JSON.stringify(v, Object.keys((v ?? {}) as object).sort());

function looksSame(kind: Kind, x: Entry, data: Args, s: number, e: number, now: number): boolean {
  const close = Math.abs(x.start - s) <= 3 * MIN;
  const xe = x.end ?? (x.active ? now : x.start);
  const overlaps = x.start < e && s < xe;
  switch (kind) {
    case "diaper":
      return close && !!x.data.pee === !!data.pee && !!x.data.poop === !!data.poop;
    case "feed":
      if (data.method === "bottle") return close && x.data.method === "bottle";
      return x.data.method !== "bottle" && (close || overlaps);
    case "sleep":
    case "tummy":
    case "pump":
    case "bath":
      return close || overlaps;
    case "med":
      return close && String(x.data.name).toLowerCase() === String(data.name).toLowerCase();
    default:
      return close && stable(x.data) === stable(data);
  }
}

export type SaveOut = { status: "created" | "deduped" | "duplicate"; entry: Entry };

/** mcp-tools.ts's save(): an identical retry comes back as already saved, and what looks like the same event asks first. */
export function save(sim: Sim, tool: string, kind: Kind, start: number, end: number | null, data: Args, a: Args, extra: Partial<Entry> = {}): SaveOut {
  const e = end ?? start;
  const nearby = sim.live().filter((x) => x.kind === kind && x.start >= start - 3 * MIN && x.start <= Math.max(start, e) + 3 * MIN);
  if (!a.allow_duplicate) {
    const retry = nearby.find((x) => x.by === sim.me && !x.active && Math.abs(x.start - start) <= 2 * MIN && sim.now - x.createdAt <= 2 * MIN && stable(x.data) === stable(data));
    if (retry) return { status: "deduped", entry: retry };
    const twin = nearby.find((x) => looksSame(kind, x, data, start, e, sim.now));
    if (twin) return { status: "duplicate", entry: twin };
    if (kind === "med" && /vitamin d|sunshine/i.test(String(data.name))) {
      const given = sim.live().find((x) => x.kind === "med" && /vitamin d/i.test(String(x.data.name)) && x.start >= sim.todayStart());
      if (given) return { status: "duplicate", entry: given };
    }
  }
  const entry = sim.add({ kind, start, end, active: false, by: sim.me, via: "chat", data, note: (a.note as string | null) ?? null, createdAt: sim.now, ...extra });
  sim.actions.push({ kind: "create", tool, id: entry.id, at: sim.now });
  return { status: "created", entry };
}

export function savedResult(sim: Sim, out: SaveOut, tail: string[], assumed: string[], json: Record<string, unknown> = {}): ReturnType<typeof ok> {
  const e = out.entry;
  const note = assumed.length ? [`Note: ${assumed.join("; ")}.`] : [];
  if (out.status === "deduped") {
    return ok([`Already saved #${e.id}: ${sim.phrase(e)} at ${sim.whenText(e.start)} (logged by ${e.by} via ${VIA}), so it wasn't added twice.`, ...note].join("\n"), { created: false, deduped: true, ...entryJson(sim, e) });
  }
  if (out.status === "duplicate") {
    return ok(
      [`Not saved: ${e.by} already logged ${sim.phrase(e)} at ${sim.whenText(e.start)} (#${e.id}), which looks like the same one. If this is a different one, call again with allow_duplicate: true.`, ...note].join("\n"),
      { created: false, possible_duplicate: { id: e.id, summary: `${sim.phrase(e)} at ${sim.whenText(e.start)}`, by: e.by, via: e.via } }
    );
  }
  return ok([savedLine(sim, e), ...tail, ...note].join("\n"), { created: true, ...entryJson(sim, e), ...json, ...(assumed.length ? { assumed } : {}), undo: `undo_last, or delete_entry with id ${e.id}` });
}
