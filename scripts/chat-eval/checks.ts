import type { Played } from "./bench";
import { MIN, type Entry, type Kind, type Side, type Sim } from "./sim";

/** What counts as correct: each check returns null for a pass, or why it failed. */

export type View = Played & { reply: string };
export type Check = { name: string; run: (v: View) => string | null };

const mins = (sim: Sim, ms: number) => Math.round((sim.now - ms) / MIN);
const fresh = (v: View, kind: Kind) => v.after.live().filter((e) => e.kind === kind && !v.before.get(e.id));

function near(sim: Sim, ms: number | null, minutesAgo: number, tol: number, what: string): string | null {
  if (ms == null) return `${what}: no time`;
  const off = mins(sim, ms);
  return Math.abs(off - minutesAgo) <= tol ? null : `${what} at ${sim.time(ms)} (${off} min ago), wanted ~${minutesAgo} min ago (±${tol})`;
}

const runningBefore = (v: View, kind: Kind) => v.before.running(kind)[0];

/** The timer of this kind that was running at the start ended about `minutesAgo` minutes before the last message. */
export function stopped(kind: Kind, minutesAgo: number, tol = 2): Check {
  return {
    name: `${kind} timer stopped ~${minutesAgo} min ago`,
    run: (v) => {
      const was = runningBefore(v, kind);
      if (!was) return "scenario has no running timer";
      const now = v.after.get(was.id);
      if (!now || now.deleted) return `#${was.id} was deleted`;
      if (now.active) return `#${was.id} is still running`;
      return near(v.after, now.end, minutesAgo, tol, `#${was.id} ended`);
    },
  };
}

/** A timer of this kind is running and started about `minutesAgo` minutes ago (on `side`, for nursing). */
export function running(kind: Kind, minutesAgo: number, tol = 2, side?: Side): Check {
  return {
    name: `${kind} timer running from ~${minutesAgo} min ago${side ? ` on ${side}` : ""}`,
    run: (v) => {
      const r = v.after.running(kind);
      if (r.length !== 1) return `${r.length} ${kind} timers running`;
      const e = r[0];
      const why = near(v.after, e.start, minutesAgo, tol, `#${e.id} started`);
      if (why) return why;
      const first = e.parts?.[0]?.side;
      return side && first !== side ? `#${e.id} started on ${first ?? "no side"}, wanted ${side}` : null;
    },
  };
}

/** The feed that was running is now on `side`, since about `minutesAgo` minutes ago. */
export function onSide(side: Side, minutesAgo: number, tol = 2): Check {
  return {
    name: `feed now on ${side} since ~${minutesAgo} min ago`,
    run: (v) => {
      const was = runningBefore(v, "feed");
      const e = was && v.after.get(was.id);
      if (!e || e.deleted || !e.active) return "the feed isn't running any more";
      const cur = e.parts![e.parts!.length - 1];
      if (cur.side !== side) return `current part is ${cur.side ?? "a break"}, wanted ${side}`;
      return near(v.after, cur.start, minutesAgo, tol, "that part started");
    },
  };
}

/** Exactly one new entry of this kind, and it matches. */
export function oneNew(kind: Kind, label: string, test: (e: Entry, sim: Sim) => string | null): Check {
  return {
    name: `one new ${kind}: ${label}`,
    run: (v) => {
      const made = fresh(v, kind);
      if (made.length !== 1) return `${made.length} new ${kind} entries${made.length ? `: ${made.map((e) => v.after.phrase(e)).join("; ")}` : ""}`;
      return test(made[0], v.after);
    },
  };
}

export const at = (minutesAgo: number, tol: number) => (e: Entry, sim: Sim) => near(sim, e.start, minutesAgo, tol, `#${e.id}`);

export function noNew(kind: Kind): Check {
  return { name: `no new ${kind}`, run: (v) => (fresh(v, kind).length ? `logged ${fresh(v, kind).map((e) => v.after.phrase(e)).join("; ")}` : null) };
}

export const noWrites: Check = {
  name: "changed nothing",
  run: (v) => {
    const w = v.calls.filter((c) => c.write && c.ok);
    return w.length ? `wrote: ${w.map((c) => c.name).join(", ")}` : null;
  },
};

export function says(re: RegExp | ((v: View) => RegExp), label: string): Check {
  return { name: `says ${label}`, run: (v) => ((typeof re === "function" ? re(v) : re).test(v.reply) ? null : `reply doesn't say ${label}`) };
}

export function saysNot(re: RegExp, label: string): Check {
  return { name: `doesn't say ${label}`, run: (v) => (re.test(v.reply) ? `reply says ${label}: "${re.exec(v.reply)![0]}"` : null) };
}

export function called(name: string, test?: (input: Record<string, unknown>) => boolean, label = ""): Check {
  return { name: `calls ${name}${label ? ` ${label}` : ""}`, run: (v) => (v.calls.some((c) => c.name === name && (!test || test((c.input ?? {}) as Record<string, unknown>))) ? null : `no ${name}${label ? ` ${label}` : ""} call`) };
}

export function notCalled(name: string, test?: (input: Record<string, unknown>) => boolean, label = ""): Check {
  return { name: `no ${name}${label ? ` ${label}` : ""}`, run: (v) => (v.calls.some((c) => c.name === name && (!test || test((c.input ?? {}) as Record<string, unknown>))) ? `called ${name}${label ? ` ${label}` : ""}` : null) };
}

const PROMISE = /\bI(?:['’]ll| will| am going to|['’]m going to)\b(?! be here)/i;
const ON_THEIR_WORD = /\b(?:tell|let|text|message|ask) me\b|\bjust say\b|\bsay the word\b|\b(?:if|when|once) you\b|\bwant me to\b/i;

/** The chat can't act later, so "I'll stop it when she wakes" is a promise it can't keep; "tell me and I'll stop it" is fine. */
export const noPromise: Check = {
  name: "promises nothing for later",
  run: (v) => {
    const s = v.turns.flatMap((t) => t.reply.split(/(?<=[.!?])\s+/)).find((x) => PROMISE.test(x) && !ON_THEIR_WORD.test(x));
    return s ? `promises: "${s}"` : null;
  },
};

export const helpCard: Check = { name: "help card shows", run: (v) => (v.turns[v.turns.length - 1].help === "crisis" ? null : "no crisis help card") };

/** The entry the first turn made is gone again, or waits on a Delete tap. */
export const firstTurnUndone: Check = {
  name: "what the first message logged is taken back",
  run: (v) => {
    const made = v.after.entries.filter((e) => !v.before.get(e.id) && e.kind === "diaper");
    if (!made.length) return "the first message logged nothing";
    if (made.every((e) => e.deleted)) return null;
    const pending = v.turns[v.turns.length - 1].pending.find((p) => p.tool === "delete_entry" && made.some((e) => e.id === (p.input as { id?: number })?.id));
    return pending ? null : `still there: ${made.filter((e) => !e.deleted).map((e) => `#${e.id}`).join(", ")}`;
  },
};

export function momDose(plan: string, minutesAgo: number, tol = 3): Check {
  return {
    name: `Brittany's ${plan} logged ~${minutesAgo} min ago`,
    run: (v) => {
      const made = v.after.doses.filter((d) => !d.deleted && !v.before.doses.some((b) => b.id === d.id));
      if (made.length !== 1) return `${made.length} new doses for her`;
      if (made[0].plan !== plan) return `logged ${made[0].plan}`;
      return near(v.after, made[0].at, minutesAgo, tol, "the dose");
    },
  };
}

// ── every scenario ───────────────────────────────────────────────────────

export type Asks = "never" | "must" | "any";

export function universal(asks: Asks): Check[] {
  const list: Check[] = [
    { name: "answered", run: (v) => (v.turns.every((t) => t.reply || t.refusal || t.pending.length) ? null : `no reply to "${v.turns.find((t) => !t.reply)?.say}"`) },
    { name: "no stream errors", run: (v) => (v.turns.some((t) => t.streamErrors.length || t.reported.length) ? [...v.turns.flatMap((t) => [...t.streamErrors, ...t.reported])].join("; ") : null) },
    { name: "no em dash", run: (v) => (v.turns.some((t) => t.reply.includes("—")) ? "reply has an em dash" : null) },
    {
      name: "every Saved # it names exists",
      run: (v) => {
        const ids = [...v.reply.matchAll(/Saved #(\d+)/g)].map((m) => Number(m[1]));
        const missing = ids.filter((id) => !v.after.get(id) || v.after.get(id)!.deleted);
        return missing.length ? `names #${missing.join(", #")} as saved` : null;
      },
    },
    { name: "every tool had a stand-in", run: (v) => (v.calls.some((c) => !c.stubbed) ? `no stand-in for ${[...new Set(v.calls.filter((c) => !c.stubbed).map((c) => c.name))].join(", ")}` : null) },
    noPromise,
  ];
  if (asks === "never") list.push({ name: "asks nothing", run: (v) => (v.reply.includes("?") ? `asks: "${v.reply.split(/(?<=[.!?])\s+/).filter((s) => s.includes("?")).join(" ")}"` : null) });
  if (asks === "must") list.push({ name: "asks one question", run: (v) => (v.reply.includes("?") ? null : "asks nothing") });
  return list;
}
