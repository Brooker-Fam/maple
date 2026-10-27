import { formatDuration } from "../../src/lib/maple/time";
import { entryJson, fail, ok, save, savedResult, type Args, type Handler } from "./result";
import { MIN, ToolErr, type Entry, type Kind, type Sim } from "./sim";
import { TIMER_TOOLS } from "./timers";

/** Stand-ins for Maple's MCP handlers, reading and changing a Sim instead of the database. */

const OZ = 29.5735;

const maple_status: Handler = (_a, sim) => {
  const age = sim.age();
  const now = new Date(sim.now);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" }).format(now);
  const timers = sim.running();
  const last = sim.lastFeed();
  const day24 = sim.counts(sim.now - 24 * 60 * MIN);
  const lines = [
    `It's ${sim.time(sim.now)} ${sim.zone()} on ${day}. Maple is ${age.label} (Day ${age.day}).`,
    ...timers.map((e) => sim.timerLine(e)),
    sim.lastFeedLine(),
    sim.nextLine(),
    sim.diaperLine(),
    sim.todayLine(),
    `Last 24 hours: ${day24.feeds} feeds, ${day24.wet} wet, ${day24.dirty} dirty.`,
    ...(sim.momLine() ? [sim.momLine()!] : []),
  ];
  const vitD = sim.live().find((e) => e.kind === "med" && /vitamin d/i.test(String(e.data.name)) && e.start >= sim.todayStart());
  if (vitD) lines.push(`Vitamin D: given at ${sim.time(vitD.start)} by ${vitD.by}.`);
  const t = sim.today();
  return ok(lines.join("\n"), {
    now: { local: sim.whenText(sim.now), tz: "America/New_York" },
    age: { label: age.label, day_of_life: age.day },
    timers: timers.map((e) => sim.timerJson(e)),
    last_feed: last ? { id: last.id, local: sim.whenText(last.start), ...(last.end ? { ended_local: sim.whenText(last.end) } : {}), minutes_ago: Math.round((sim.now - last.start) / MIN), what: sim.phrase(last), by: last.by } : null,
    next_side: sim.nextSide(),
    today: { feeds: t.feeds, wet: t.wet, dirty: t.dirty, sleep_minutes: t.sleepMin },
    last_24h: day24,
    vitamin_d_today: vitD ? { local: sim.whenText(vitD.start), by: vitD.by } : null,
    alerts: [],
    speak: `${last ? `Maple last ate ${formatDuration((sim.now - last.start) / 1000)} ago.` : ""} Next side: ${sim.nextSide()}.`.trim(),
  });
};

const KIND_ARG: Record<string, Kind> = { feed: "feed", diaper: "diaper", sleep: "sleep", pump: "pump", growth: "growth", temperature: "temp", vitals: "vitals", medicine: "med", tummy_time: "tummy", bath: "bath", moment: "moment", note: "note" };

const list_entries: Handler = (a, sim) => {
  let from = sim.now - Number(a.hours ?? 12) * 60 * MIN;
  let to = sim.now;
  if (a.day === "today") from = sim.todayStart();
  if (a.day === "yesterday") {
    to = sim.todayStart();
    from = to - 24 * 60 * MIN;
  }
  const kind = a.kind ? KIND_ARG[String(a.kind)] : null;
  const rows = sim
    .live()
    .filter((e) => e.start >= from && e.start <= to && (!kind || e.kind === kind))
    .sort((x, y) => y.start - x.start)
    .slice(0, Number(a.limit ?? 30));
  const text = rows.map((e) => `#${e.id} ${sim.whenText(e.start)}: ${sim.phrase(e)} (${e.by} via ${e.via === "chat" ? "Maple chat" : e.via})`);
  return ok([`${rows.length} entries${a.day ? ` ${a.day}` : ` in the last ${a.hours ?? 12} hours`}, newest first:`, ...text].join("\n"), { entries: rows.map((e) => entryJson(sim, e)) });
};

const daily_summary: Handler = (a, sim) => {
  const days = Number(a.days ?? 7);
  const lines: string[] = [];
  for (let i = 0; i < Math.min(days, 2); i++) {
    const end = i === 0 ? sim.now : sim.todayStart();
    const start = i === 0 ? sim.todayStart() : sim.todayStart() - 24 * 60 * MIN;
    const c = sim.counts(start, end);
    lines.push(`${i === 0 ? "Today" : "Yesterday"}: ${c.feeds} feeds, ${c.wet} wet, ${c.dirty} dirty, ${formatDuration(c.sleepMin * 60)} sleep.`);
  }
  return ok(lines.join("\n"), { days: lines });
};

function timeArgs(sim: Sim, a: Args, assumed: string[]) {
  const start = sim.when(a.at as string, a.minutes_ago as number, assumed);
  const end = sim.when(a.ended_at as string, a.ended_minutes_ago as number, assumed, "the end time");
  return { start, end };
}

const log_feed: Handler = (a, sim) => {
  const assumed: string[] = [];
  const t = timeArgs(sim, a, assumed);
  if (a.method === "bottle") {
    if (a.amount == null) throw new ToolErr("A bottle needs amount (and unit, oz by default).");
    const ml = Math.round(Number(a.amount) * (a.unit === "ml" ? 1 : OZ));
    const start = t.start ?? t.end ?? sim.now;
    const out = save(sim, "log_feed", "feed", start, start + 10 * MIN, { method: "bottle", amount_ml: ml, ...(a.milk ? { milk: a.milk } : {}) }, a);
    return savedResult(sim, out, [sim.todayLine(), `Next feed: offer the ${sim.nextSide()} side first.`], assumed, { next_side: sim.nextSide() });
  }
  const l = Number(a.left_minutes ?? 0);
  const r = Number(a.right_minutes ?? 0);
  const b = Number(a.both_minutes ?? 0);
  const total = l + r + b;
  if (!total) throw new ToolErr("A breastfeed needs left_minutes, right_minutes or both_minutes. For a feed happening now, use start_timer.");
  const end = t.end ?? (t.start != null ? t.start + total * MIN : sim.now);
  const start = t.start ?? end - total * MIN;
  const first = a.first_side === "right" ? "R" : a.first_side === "left" ? "L" : l ? "L" : "R";
  const order = first === "L" ? ([["L", l], ["R", r]] as const) : ([["R", r], ["L", l]] as const);
  const parts: Entry["parts"] = [];
  let at = start;
  for (const [side, m] of [...order, ["B", b] as const]) {
    if (!m) continue;
    parts.push({ side, start: at, end: at + m * MIN });
    at += m * MIN;
  }
  const out = save(sim, "log_feed", "feed", start, end, { method: "breast", first_side: first === "L" ? "left" : "right" }, a, { parts });
  return savedResult(sim, out, [sim.todayLine(), `Next feed: offer the ${sim.nextSide()} side first.`], assumed, { next_side: sim.nextSide() });
};

const log_diaper: Handler = (a, sim) => {
  const assumed: string[] = [];
  const at = sim.when(a.at as string, a.minutes_ago as number, assumed) ?? sim.now;
  const d = String(a.diaper);
  const data: Args = { pee: d === "wet" || d === "both", poop: d === "dirty" || d === "both" };
  for (const k of ["color", "texture", "size", "rash"]) if (a[k] != null) data[k] = a[k];
  const out = save(sim, "log_diaper", "diaper", at, null, data, a);
  const t = sim.today();
  return savedResult(sim, out, [`Today so far: ${t.wet} wet, ${t.dirty} dirty.`], assumed, { today: { wet: t.wet, dirty: t.dirty } });
};

const log_sleep: Handler = (a, sim) => {
  const assumed: string[] = [];
  const t = timeArgs(sim, a, assumed);
  const dur = a.duration_minutes != null ? Number(a.duration_minutes) * MIN : null;
  const end = t.end ?? (t.start != null && dur != null ? t.start + dur : sim.now);
  const start = t.start ?? (dur != null ? end - dur : null);
  if (start == null) throw new ToolErr("Give two of start (at / minutes_ago), end (ended_at / ended_minutes_ago) and duration_minutes. For a sleep happening now use start_timer.");
  const out = save(sim, "log_sleep", "sleep", start, end, a.place ? { place: a.place } : {}, a);
  return savedResult(sim, out, [], assumed);
};

const log_medicine: Handler = (a, sim) => {
  const assumed: string[] = [];
  const at = sim.when(a.at as string, a.minutes_ago as number, assumed) ?? sim.now;
  const name = String(a.name ?? "Vitamin D");
  const dose = a.dose ?? (/vitamin d|sunshine/i.test(name) ? "400 IU" : null);
  const out = save(sim, "log_medicine", "med", at, null, { name, ...(dose ? { dose } : {}) }, a);
  const hers = sim.care && !a.for_maple && sim.plans.find((p) => [p.name, ...p.also].some((n) => n.toLowerCase() === name.toLowerCase()));
  return savedResult(sim, out, hers ? [`Note: her mom has ${hers.name} on her list. If this was Brittany's dose, delete this one and log it with log_mom_medicine.`] : [], assumed);
};

/** Writes this bench doesn't need to model in detail: saved as an entry of that kind, as the real tool does. */
function plain(tool: string, kind: Kind): Handler {
  return (a, sim) => {
    const assumed: string[] = [];
    const at = sim.when(a.at as string, a.minutes_ago as number, assumed) ?? sim.now;
    const { at: _at, minutes_ago: _m, client_ref: _c, allow_duplicate: _d, ...data } = a;
    void _at, void _m, void _c, void _d;
    return savedResult(sim, save(sim, tool, kind, at, null, data, a), [], assumed);
  };
}

const MANY: Record<string, (item: Args) => [Handler, Args]> = {
  breastfeed: (i) => [log_feed, { ...i, method: "breast" }],
  bottle: (i) => [log_feed, { ...i, method: "bottle" }],
  diaper: (i) => [log_diaper, i],
  sleep: (i) => [log_sleep, i],
  medicine: (i) => [log_medicine, i],
};

const log_many: Handler = (a, sim) => {
  const items = (a.entries as Args[] | undefined) ?? [];
  const lines: string[] = [];
  const results: unknown[] = [];
  for (const item of items) {
    const [h, args] = MANY[String(item.kind)]?.(item) ?? [plain("log_many", (KIND_ARG[String(item.kind)] ?? "note") as Kind), item];
    try {
      const r = h({ ...args, allow_duplicate: a.allow_duplicate ?? args.allow_duplicate }, sim);
      const text = (r.content[0] as { text: string }).text;
      lines.push(text.split("\n")[0]);
      results.push(r.structuredContent);
    } catch (e) {
      lines.push(`Not saved (${item.kind}): ${(e as Error).message}`);
      results.push({ created: false, error: (e as Error).message });
    }
  }
  return ok(lines.join("\n"), { results });
};

const update_entry: Handler = (a, sim) => {
  const e = sim.get(Number(a.id));
  if (!e || e.deleted) throw new ToolErr(`There's no entry #${a.id}. Use list_entries to find the right id.`);
  const assumed: string[] = [];
  const t = timeArgs(sim, a, assumed);
  if (t.start != null) {
    const shift = t.start - e.start;
    e.start = t.start;
    for (const p of e.parts ?? []) {
      p.start += shift;
      if (p.end) p.end += shift;
    }
  }
  if (t.end != null) e.end = t.end;
  if (a.duration_minutes != null) e.end = e.start + Number(a.duration_minutes) * MIN;
  if (a.note != null) e.note = String(a.note) || null;
  if (a.details && typeof a.details === "object") Object.assign(e.data, a.details);
  sim.actions.push({ kind: "change", tool: "update_entry", id: e.id, at: sim.now });
  return ok(`Updated #${e.id}: ${sim.phrase(e)} at ${sim.whenText(e.start)}.`, { updated: true, ...entryJson(sim, e) });
};

const delete_entry: Handler = (a, sim) => {
  const e = sim.get(Number(a.id));
  if (!e || e.deleted) throw new ToolErr(`There's no entry #${a.id}. Use list_entries to find the right id.`);
  e.deleted = true;
  return ok(`Deleted #${e.id}: ${sim.phrase(e)} at ${sim.whenText(e.start)}. restore_entry with id ${e.id} brings it back.`, { deleted: true, id: e.id });
};

const restore_entry: Handler = (a, sim) => {
  const e = sim.get(Number(a.id));
  if (!e || !e.deleted) throw new ToolErr(`#${a.id} isn't deleted.`);
  e.deleted = false;
  return ok(`Restored #${e.id}: ${sim.phrase(e)} at ${sim.whenText(e.start)}.`, { restored: true, ...entryJson(sim, e) });
};

const undo_last: Handler = (_a, sim) => {
  const recent = sim.actions.filter((x) => sim.now - x.at <= 30 * MIN);
  const last = recent[recent.length - 1];
  if (!last) return ok("Nothing to undo: you haven't logged anything through an assistant in the last 30 minutes.", { undone: false });
  if (last.kind === "change") {
    return ok(`Your last action changed #${last.id} (${last.tool}), so nothing was removed. A mistaken switch or pause: fix_nursing_time {undo_last_tap:true}; a time fix: the undo token in that fix's reply; a stop: reopen_timer id ${last.id}.`, { undone: false, last_change: last.tool, id: last.id });
  }
  sim.actions.pop();
  if (last.mom) {
    const d = sim.doses.find((x) => x.id === last.id)!;
    d.deleted = true;
    return ok(`Removed Brittany's ${d.plan} at ${sim.whenText(d.at)} (#p${d.id}). fix_mom_entry with action "restore" brings it back.`, { undone: true, mom: true, id: `p${d.id}` });
  }
  const e = sim.get(last.id)!;
  e.deleted = true;
  return ok(`Removed #${e.id}: ${sim.phrase(e)} at ${sim.whenText(e.start)}. restore_entry with id ${e.id} brings it back.`, { undone: true, deleted: true, id: e.id });
};

// ── her page ─────────────────────────────────────────────────────────────

const SAME: Record<string, string> = { tylenol: "acetaminophen", acetaminophen: "tylenol", advil: "ibuprofen", motrin: "ibuprofen", ibuprofen: "advil" };

function momPlan(sim: Sim, name: string) {
  const n = name.trim().toLowerCase();
  return sim.plans.find((p) => [p.name, ...p.also].some((x) => x.toLowerCase() === n || SAME[n] === x.toLowerCase() || SAME[x.toLowerCase()] === n));
}

const mom_status: Handler = (a, sim) => {
  const plans = a.medicine ? sim.plans.filter((p) => p === momPlan(sim, String(a.medicine))) : sim.plans;
  const lines = [`Brittany's medicines (from her plan; not advice):`, ...plans.map((p) => sim.momState(p).sentence), "Her OB: Dr. Example's office, 555-0100 (made up). National Maternal Mental Health Hotline: call or text 1-833-852-6262."];
  return ok(lines.join("\n"), { medicines: plans.map((p) => ({ name: p.name, line: sim.momState(p).sentence })) });
};

const log_mom_medicine: Handler = (a, sim) => {
  const assumed: string[] = [];
  const at = sim.when(a.at as string, a.minutes_ago as number, assumed) ?? sim.now;
  const plan = a.one_off ? undefined : momPlan(sim, String(a.medicine));
  const name = plan?.name ?? String(a.medicine);
  const twin = sim.doses.find((d) => !d.deleted && d.plan === name && Math.abs(d.at - at) <= 30 * MIN);
  if (twin && !a.allow_duplicate) {
    return ok(`Not saved: ${twin.by} logged ${name} for Brittany at ${sim.whenText(twin.at)} (#p${twin.id}). If this is another dose, call again with allow_duplicate: true.`, { created: false, possible_duplicate: { id: `p${twin.id}`, at: sim.whenText(twin.at), by: twin.by } });
  }
  const d = { id: sim.nextDose++, plan: name, at, by: sim.me, via: "chat", createdAt: sim.now };
  sim.doses.push(d);
  sim.actions.push({ kind: "create", tool: "log_mom_medicine", id: d.id, mom: true, at: sim.now });
  const st = plan ? sim.momState(plan) : null;
  return ok([`Saved #p${d.id}: ${name} for Brittany at ${sim.whenText(at)} (logged by ${sim.me} via Maple chat).`, ...(st ? [st.sentence] : ["Saved as a one-time medicine (not on her list)."])].join("\n"), { created: true, id: `p${d.id}`, medicine: name, local: sim.whenText(at) });
};

function momPlain(what: string): Handler {
  return (a, sim) => ok(`Saved for Brittany: ${what}${a.question ? ` "${a.question}"` : ""} at ${sim.whenText(sim.now)} (logged by ${sim.me} via Maple chat).`, { created: true });
}

const fix_mom_entry: Handler = (a) => fail(`fix_mom_entry: nothing in this made-up log matches ${JSON.stringify(a.id ?? null)}.`);

export const HANDLERS: Record<string, Handler> = {
  maple_status,
  list_entries,
  daily_summary,
  get_moments: () => ok("No moments saved yet.", { moments: [] }),
  list_doctor_questions: () => ok("No open questions for the doctor.", { questions: [] }),
  log_feed,
  log_diaper,
  log_sleep,
  ...TIMER_TOOLS,
  log_growth: plain("log_growth", "growth"),
  log_temperature: plain("log_temperature", "temp"),
  log_vitals: plain("log_vitals", "vitals"),
  log_medicine,
  log_pump: plain("log_pump", "pump"),
  log_activity: plain("log_activity", "tummy"),
  log_moment: plain("log_moment", "moment"),
  log_note: plain("log_note", "note"),
  add_doctor_question: plain("add_doctor_question", "note"),
  log_many,
  update_entry,
  delete_entry,
  restore_entry,
  undo_last,
  mom_status,
  log_mom_medicine,
  log_mom_temperature: momPlain("temperature"),
  add_mom_question: momPlain("question for her OB"),
  fix_mom_entry,
  record_birth: () => fail("She's already born; her birth is recorded."),
};

export function runHandler(name: string, args: Args, sim: Sim) {
  const h = HANDLERS[name];
  if (!h) return null;
  try {
    return h(args, sim);
  } catch (e) {
    if (e instanceof ToolErr) return fail(e.message);
    throw e;
  }
}
