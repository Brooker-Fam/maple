"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SleepInputError } from "@/lib/maple/sleep/errors";
import { cleanGoalInput, windowMinutes, type GoalRules } from "@/lib/maple/sleep/goals";
import {
  GOAL_AHEAD_DAYS,
  GOAL_CUSTOM_MAX,
  GOAL_STEP_TITLE_MAX,
  GOAL_STEPS_MAX,
  GOAL_TARGETS_MAX,
  GOAL_TITLE_MAX,
  GOAL_WHY_MAX,
  ROSTER_MAX,
  TARGET_KINDS,
  WINDOW_COVERS,
  type GoalInput,
  type GoalTargetInput,
  type SleepGoal,
  type TargetKind,
  type WindowCovers,
} from "@/lib/maple/sleep/types";
import { clockLabel, COVERS_LABEL, coversHint, dateWords, GOAL_STATUS_LABEL, minutesWords, nightsLabel, TARGET_KIND_LABEL, WEEKDAY_SHORT, windowTimes } from "@/lib/maple/sleep/words";
import { addDays, dayKey, daysBetween, DEFAULT_TZ, isDayKey } from "@/lib/maple/time";
import { useVoice } from "../familyWords";
import { Icon } from "../icons";
import { ContextNote, Label, SheetFooter } from "../sheets/parts";
import { Chip, cx, Segmented, Sheet, Stepper, TextArea, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useSleep } from "./useSleep";

/**
 * A sleep goal by hand, for a family that would rather not set one in the
 * chat: a title, why it matters, a target date, targets by kind, weekly
 * steps and a night roster of protected windows. It checks itself with the
 * same rules the server uses (goals.ts cleanGoalInput) and says what to fix
 * by the field (a plan Maple won't make says so on Save, never while it's
 * being typed, with a wording to try). An edit sends only what changed, with the goal's revision;
 * a goal changed on another phone meanwhile comes back as it is now, with
 * this person's changes kept on top, to look over and save again.
 */

type TargetDraft = { key: string; id: string | null; kind: TargetKind; per_week: number | null; min_minutes: number | null; minutes: number | null; member: string; text: string };
type StepDraft = { key: string; id: string | null; title: string; week_of: string; done: string | null };
type WindowDraft = { key: string; id: string | null; member: string; from: string; to: string; nights: number[]; covers: WindowCovers | null };
type Draft = { title: string; why: string; target_date: string; status: "active" | "paused"; targets: TargetDraft[]; steps: StepDraft[]; roster: WindowDraft[] };

const FIELDS = ["title", "why", "target_date", "status", "targets", "steps", "roster"] as const;
const EVERY_NIGHT = [0, 1, 2, 3, 4, 5, 6];
const NEEDED = /is needed\.$/;
/** A plan Maple won't make (goals.ts unsafeWords): said on Save, not while the words are being typed. */
const UNSAFE = /: Maple won't plan /;

let keys = 0;
const nextKey = () => `k${++keys}`;
/** Spaces as the server keeps them, so an unchanged field compares equal. */
const words = (s: string) => s.replace(/\s+/g, " ").trim();

function draftOf(g: SleepGoal | null, who: string): Draft {
  if (!g) return { title: "", why: "", target_date: "", status: "active", targets: [], steps: [], roster: [] };
  return {
    title: g.title,
    why: g.why ?? "",
    target_date: g.target_date ?? "",
    status: g.status === "paused" ? "paused" : "active",
    targets: g.targets.map((t) => ({
      key: nextKey(),
      id: t.id,
      kind: t.kind,
      per_week: t.kind === "bassinet_nights" || t.kind === "protected_window" ? t.per_week : 4,
      min_minutes: t.kind === "bassinet_nights" ? t.min_minutes : 60,
      minutes: t.kind === "bassinet_stretch" ? t.minutes : 120,
      member: t.kind === "protected_window" ? t.member : who,
      text: t.kind === "custom" ? t.text : "",
    })),
    steps: g.steps.map((s) => ({ key: nextKey(), id: s.id, title: s.title, week_of: s.week_of ?? "", done: s.done_at })),
    roster: g.roster.map((w) => ({ key: nextKey(), id: w.id, member: w.member, from: w.from, to: w.to, nights: [...w.nights], covers: w.covers ?? null })),
  };
}

function targetInput(t: TargetDraft): GoalTargetInput {
  const id = t.id ? { id: t.id } : {};
  switch (t.kind) {
    case "bassinet_nights":
      return { ...id, kind: t.kind, per_week: t.per_week, min_minutes: t.min_minutes };
    case "bassinet_stretch":
      return { ...id, kind: t.kind, minutes: t.minutes };
    case "protected_window":
      return { ...id, kind: t.kind, member: t.member, per_week: t.per_week };
    case "custom":
      return { ...id, kind: t.kind, text: words(t.text) };
  }
}

/** The draft as goal.create and goal.update take it (every field). */
function inputOf(d: Draft): Required<Pick<GoalInput, (typeof FIELDS)[number]>> {
  return {
    title: words(d.title),
    why: words(d.why) || null,
    target_date: d.target_date || null,
    status: d.status,
    targets: d.targets.map(targetInput),
    steps: d.steps.map((s) => ({ ...(s.id ? { id: s.id } : {}), title: words(s.title), week_of: s.week_of || null })),
    roster: d.roster.map((w) => ({ ...(w.id ? { id: w.id } : {}), member: w.member, from: w.from, to: w.to, nights: [...new Set(w.nights)].sort((a, b) => a - b), ...(w.covers ? { covers: w.covers } : {}) })),
  };
}

/** A new goal: every field but the status (a new goal starts active). */
function createInput(d: Draft): GoalInput {
  const { title, why, target_date, targets, steps, roster } = inputOf(d);
  return { title, why, target_date, targets, steps, roster };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An edit: only the fields that changed (a list given replaces the whole list, so an untouched one stays out). */
function patchOf(d: Draft, base: Draft): GoalInput {
  const a = inputOf(d);
  const b = inputOf(base);
  const patch: Record<string, unknown> = {};
  for (const k of FIELDS) if (!same(a[k], b[k])) patch[k] = a[k];
  return patch as GoalInput;
}

/**
 * After a 409: the goal as it is now, with the fields this person changed
 * (against the version they started from) kept; their items that the newer
 * goal no longer has go back as new ones.
 */
function rebase(d: Draft, was: Draft, cur: SleepGoal, who: string): Draft {
  const now = draftOf(cur, who);
  const a = inputOf(d);
  const b = inputOf(was);
  const mine = (k: (typeof FIELDS)[number]) => !same(a[k], b[k]);
  const keep = <T extends { id: string | null }>(xs: T[], have: { id: string }[]) => xs.map((x) => (x.id && !have.some((h) => h.id === x.id) ? { ...x, id: null } : x));
  return {
    title: mine("title") ? d.title : now.title,
    why: mine("why") ? d.why : now.why,
    target_date: mine("target_date") ? d.target_date : now.target_date,
    status: mine("status") ? d.status : now.status,
    targets: mine("targets") ? keep(d.targets, cur.targets) : now.targets,
    steps: mine("steps") ? keep(d.steps, cur.steps) : now.steps,
    roster: mine("roster") ? keep(d.roster, cur.roster) : now.roster,
  };
}

type Where = { at: "title" | "why" | "date" | "targets" | "steps" | "roster" | "form"; index?: number; message: string };

/** Which field a rule's words are about: "Target 2: …", "Windows 1 and 2 overlap …", "The goal's title …". */
function place(message: string): Where {
  const n = (re: RegExp) => {
    const m = re.exec(message);
    return m ? Number(m[1]) - 1 : undefined;
  };
  if (/^Targets? |^A goal has \d+ targets/.test(message)) return { at: "targets", index: n(/^Target (\d+)/), message };
  if (/^Steps? |^A goal has \d+ steps/.test(message)) return { at: "steps", index: n(/^Step (\d+)/), message };
  // "Windows 1 and 2 overlap": the later one (the one just added or moved) is the one to fix.
  if (/^Windows \d+ and \d+ overlap/.test(message)) return { at: "roster", index: n(/^Windows \d+ and (\d+)/), message };
  if (/^Windows? |^The roster/.test(message)) return { at: "roster", index: n(/^Windows? (\d+)/), message };
  if (/^The goal's title/.test(message)) return { at: "title", message };
  if (/^Why it matters/.test(message)) return { at: "why", message };
  if (/^The target date/.test(message)) return { at: "date", message };
  return { at: "form", message };
}

function check(input: GoalInput, rules: GoalRules, mode: "create" | "update"): Where | null {
  try {
    cleanGoalInput(input, rules, mode);
    return null;
  } catch (err) {
    if (err instanceof SleepInputError) return place(err.message);
    throw err;
  }
}

/** A problem by its field, in danger ink (the first one the rules find). */
function Problem({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" data-goal-problem className="mt-1.5 text-[13px] font-semibold text-mp-danger">
      {children}
    </p>
  );
}

const BAD = "border-mp-danger! ring-2! ring-mp-danger/25!";

/** What another phone changed (against the version this person started from), for "Alex changed this" by each field. */
type Elsewhere = { who: string; fields: Set<(typeof FIELDS)[number]>; windows: Map<string, string> };

function changedElsewhere(was: Draft, now: Draft, cur: SleepGoal, who: string): Elsewhere {
  const a = inputOf(was);
  const b = inputOf(now);
  const fields = new Set(FIELDS.filter((k) => !same(a[k], b[k])));
  // A window it changed or added, by id: its times now, so the mark says what it became.
  const windows = new Map<string, string>();
  for (const w of cur.roster) {
    const before = was.roster.find((x) => x.id === w.id);
    if (!before || before.from !== w.from || before.to !== w.to || before.member !== w.member || before.covers !== (w.covers ?? null) || !same([...before.nights].sort(), [...w.nights].sort())) windows.set(w.id, windowTimes(w));
  }
  return { who, fields, windows };
}

function Changed({ children }: { children?: string | null }) {
  if (!children) return null;
  return <p className="mt-1.5 text-[13px] font-semibold text-mp-accent-fg">{children}</p>;
}

/**
 * A night goes by the evening it begins: "Sun night" runs into Monday
 * morning, so a window starting after midnight is that next morning's.
 */
function nightWords(w: Pick<WindowDraft, "from" | "to" | "nights">): string {
  const first = [...w.nights].sort((a, b) => a - b)[0];
  if (first == null || !/^\d{2}:\d{2}$/.test(w.from)) return "A night goes by the evening it begins.";
  const early = Number(w.from.slice(0, 2)) < 12;
  return early
    ? `A night goes by its evening: on ${WEEKDAY_SHORT[first]} night this is ${clockLabel(w.from)} early ${WEEKDAY_SHORT[(first + 1) % 7]}.`
    : `A night goes by its evening: ${WEEKDAY_SHORT[first]} night starts ${clockLabel(w.from)} ${WEEKDAY_SHORT[first]}.`;
}

/** "02:00" four hours on from "22:00": a new window's default end. */
function hoursOn(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + hours * 60) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-ink/5">
      <Icon name="x" size={18} />
    </button>
  );
}

function Section({ title, count, max, children }: { title: string; count: number; max: number; children: ReactNode }) {
  return (
    <section className="space-y-2.5" aria-label={title}>
      <h3 className={cx(tone.heading, "flex items-baseline justify-between gap-2 px-1 text-[16px]")}>
        {title}
        <span className={cx(tone.faint, "text-[12px] font-normal tabular-nums")}>
          {count} of {max}
        </span>
      </h3>
      {children}
    </section>
  );
}

export function GoalFormSheet({ goal, open = true, onClose }: { goal: SleepGoal | null; open?: boolean; onClose: () => void }) {
  const { state, memberName, now } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  const members = useMemo(() => state?.members ?? [], [state?.members]);
  // The adults who check in (owners and members): the rules' list, and the people the form offers (the signed-in one first, never the shared admin login).
  const adultIds = useMemo(() => new Set(members.filter((m) => m.role === "owner" || m.role === "member").map((m) => m.email)), [members]);
  const people = useMemo(() => {
    const list = members.filter((m) => adultIds.has(m.email) && m.email !== "admin");
    return [...list.filter((m) => m.email === s.me), ...list.filter((m) => m.email !== s.me)];
  }, [adultIds, members, s.me]);
  const who = people[0]?.email ?? s.me;
  const label = (id: string) => (id === s.me ? "Me" : memberName(id));

  // The version this draft was made from: the goal as it opened, or as it was after another phone's change.
  const [base, setBase] = useState<SleepGoal | null>(goal);
  const [draft, setDraft] = useState<Draft>(() => draftOf(goal, who));
  const was = useMemo(() => draftOf(base, who), [base, who]);
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // A plan Maple won't make, as Save found it: shown until the next edit, then again on the next Save.
  const [onSave, setOnSave] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState<Elsewhere | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Windows this person has set (who, times, nights): an overlap shows on them at once, on a fresh default only after Save.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const body = useRef<HTMLDivElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);

  const editing = !!base;
  const patch = editing ? patchOf(draft, was) : null;
  const input = patch ?? createInput(draft);
  const dirty = editing ? Object.keys(patch!).length > 0 : !same(createInput(draft), createInput(draftOf(null, who)));
  const rules: GoalRules = { current: base, adults: adultIds, name: memberName, today, seq: 0, v };
  const found = check(input, rules, editing ? "update" : "create");
  // A field still to fill in says so once Save is tapped, and so does an overlap no one has set yet (a window just added);
  // anything else shows as soon as it's there.
  const overlapUntouched = (m: string) => {
    const nums = /^Windows (\d+) and (\d+) overlap/.exec(m);
    return !!nums && [nums[1], nums[2]].every((n) => !touched.has(draft.roster[Number(n) - 1]?.key ?? ""));
  };
  const shownNow = (f: Where) => (UNSAFE.test(f.message) ? onSave === f.message : tried || (!NEEDED.test(f.message) && !overlapUntouched(f.message)));
  const shown: Where | null = refusal ? place(refusal) : found && shownNow(found) ? found : null;
  const at = (where: Where["at"], index?: number) => (shown && shown.at === where && (index === undefined ? shown.index === undefined : shown.index === index) ? shown.message : null);

  // A save turned away: bring its words into view.
  useEffect(() => {
    if (!attempt) return;
    body.current?.closest("[role=dialog]")?.querySelector("[data-goal-problem]")?.scrollIntoView({ block: "center" });
  }, [attempt]);
  // Changed on another phone: its notice, at the top of a tall form, comes into view.
  useEffect(() => {
    if (elsewhere) alert.current?.scrollIntoView({ block: "start" });
  }, [elsewhere]);

  const edit = (fn: (d: Draft) => Draft) => {
    setDraft(fn);
    setRefusal(null);
    setOnSave(null);
  };
  const setTarget = (key: string, change: Partial<TargetDraft>) => edit((d) => ({ ...d, targets: d.targets.map((t) => (t.key === key ? { ...t, ...change } : t)) }));
  const setStep = (key: string, change: Partial<StepDraft>) => edit((d) => ({ ...d, steps: d.steps.map((x) => (x.key === key ? { ...x, ...change } : x)) }));
  const setWindow = (key: string, change: Partial<WindowDraft>) => {
    setTouched((t) => new Set(t).add(key));
    edit((d) => ({ ...d, roster: d.roster.map((w) => (w.key === key ? { ...w, ...change } : w)) }));
  };

  const addTarget = (kind: TargetKind) =>
    edit((d) => ({ ...d, targets: [...d.targets, { key: nextKey(), id: null, kind, per_week: kind === "protected_window" ? 5 : 3, min_minutes: 60, minutes: 120, member: who, text: "" }] }));
  const addStep = () => edit((d) => ({ ...d, steps: [...d.steps, { key: nextKey(), id: null, title: "", week_of: "", done: null }] }));
  // A new window takes over where the last one ends, for the other adult, on the same nights: 10 PM–2 AM, then 2 AM–6 AM.
  const addWindow = () =>
    edit((d) => {
      const last = d.roster[d.roster.length - 1];
      const member = last ? (people.find((p) => p.email !== last.member)?.email ?? last.member) : who;
      const from = last ? last.to : "22:00";
      return { ...d, roster: [...d.roster, { key: nextKey(), id: null, member, from, to: hoursOn(from, 4), nights: last ? [...last.nights] : [...EVERY_NIGHT], covers: null }] };
    });

  const save = async () => {
    setTried(true);
    if (found) {
      if (UNSAFE.test(found.message)) setOnSave(found.message);
      setAttempt((n) => n + 1);
      return;
    }
    if (editing && !dirty) return onClose();
    const r = base ? await s.updateGoal(base, input, { form: true }) : await s.createGoal(input);
    if (!r) return;
    if ("saved" in r) return onClose();
    if ("problem" in r) {
      setRefusal(r.problem);
      setAttempt((n) => n + 1);
      return;
    }
    // Changed on another phone since this opened: theirs now, with this person's changes kept on top, to check and save again.
    setDraft((d) => rebase(d, was, r.conflict, who));
    setBase(r.conflict);
    setElsewhere(changedElsewhere(was, draftOf(r.conflict, who), r.conflict, r.conflict.updated_by ? memberName(r.conflict.updated_by) : "Someone"));
  };
  // "Alex changed this": by the field, with what it is now (the field shows this person's change when they made one too).
  const theirs = (k: (typeof FIELDS)[number], now?: string | null) =>
    elsewhere?.fields.has(k) ? (patchOf(draft, was)[k] !== undefined ? `${elsewhere.who} changed this too; your change is kept` : `${elsewhere.who} changed this${now ? `: ${now}` : ""}`) : null;

  const date = isDayKey(draft.target_date) ? draft.target_date : null;
  const away = date ? daysBetween(today, date) : null;

  return (
    <Sheet
      open={open}
      dirty={dirty}
      onClose={onClose}
      title={editing ? "Change the sleep goal" : "New sleep goal"}
      subtitle={editing ? base!.title : "What you're working toward, and how you'll know"}
      footer={
        <SheetFooter
          onClose={onClose}
          onPrimary={() => void save()}
          label={editing ? "Save changes" : "Save the goal"}
          busy={s.busy}
          hint={elsewhere ? `${elsewhere.who} changed this goal on another phone. Look it over, then save again.` : tried && shown ? "Check the words in red above." : undefined}
        />
      }
    >
      <div ref={body} className="min-w-0 space-y-6">
        {elsewhere && (
          <p ref={alert} role="alert" className={cx(tone.inset, "scroll-mt-4 px-4 py-3 text-[15px] leading-relaxed text-mp-ink")}>
            Someone changed this goal on another phone just now, so nothing was saved yet. This shows their version, with your changes kept on top. Look it over, then save again.
          </p>
        )}

        <div className="space-y-4">
          <div>
            <Label>Goal</Label>
            <input
              className={cx(tone.input, at("title") && BAD)}
              aria-label="Goal"
              value={draft.title}
              maxLength={GOAL_TITLE_MAX}
              placeholder="Like “both of us get one 4-hour stretch”"
              onChange={(e) => edit((d) => ({ ...d, title: e.target.value }))}
            />
            <Problem>{at("title")}</Problem>
            <Changed>{theirs("title", base ? `“${base.title}”` : null)}</Changed>
          </div>
          <div>
            <Label optional>Why it matters</Label>
            <TextArea ariaLabel="Why it matters" maxLength={GOAL_WHY_MAX} value={draft.why} onChange={(v) => edit((d) => ({ ...d, why: v }))} placeholder="In your words, like “back to work on the 30th”" />
            <Problem>{at("why")}</Problem>
            <Changed>{theirs("why")}</Changed>
          </div>
          <div>
            <Label optional>Target date</Label>
            <div className="flex items-center gap-1">
              <input
                type="date"
                aria-label="Target date"
                value={draft.target_date}
                min={today}
                max={addDays(today, GOAL_AHEAD_DAYS)}
                onChange={(e) => edit((d) => ({ ...d, target_date: e.target.value }))}
                className={cx(tone.input, "min-w-0 flex-1", at("date") && BAD)}
              />
              {draft.target_date && <RemoveButton label="Clear the target date" onClick={() => edit((d) => ({ ...d, target_date: "" }))} />}
            </div>
            {at("date") ? (
              <Problem>{at("date")}</Problem>
            ) : (
              <p className={cx(tone.muted, "mt-1.5 text-[13px]")}>
                {date && away != null
                  ? `${dateWords(date, today)}, ${away === 0 ? "today" : away === 1 ? "tomorrow" : away > 0 ? `${away} days from today` : `${-away} days ago`}`
                  : "A day to look back at it together, if there is one."}
              </p>
            )}
            <Changed>{theirs("target_date", base?.target_date ? dateWords(base.target_date, today) : "none")}</Changed>
          </div>
          {editing && base!.status !== "met" && base!.status !== "dropped" && (
            <div>
              <Label>Status</Label>
              <Segmented<"active" | "paused">
                aria-label="Status"
                value={draft.status}
                onChange={(v) => edit((d) => ({ ...d, status: v }))}
                options={[
                  { value: "active", label: "Active" },
                  { value: "paused", label: "Paused" },
                ]}
              />
              <Changed>{theirs("status", base ? GOAL_STATUS_LABEL[base.status] : null)}</Changed>
            </div>
          )}
        </div>

        <Section title="Targets" count={draft.targets.length} max={GOAL_TARGETS_MAX}>
          {draft.targets.map((t, i) => (
            <div key={t.key} className={cx(tone.inset, "space-y-3 px-3.5 py-3")} role="group" aria-label={`Target ${i + 1}: ${TARGET_KIND_LABEL[t.kind]}`}>
              <div className="flex items-center justify-between gap-2">
                <p className={cx(tone.heading, "text-[15px]")}>{TARGET_KIND_LABEL[t.kind]}</p>
                <RemoveButton label={`Remove target ${i + 1}`} onClick={() => edit((d) => ({ ...d, targets: d.targets.filter((x) => x.key !== t.key) }))} />
              </div>
              {t.kind === "bassinet_nights" && (
                <>
                  <div>
                    <Label>Nights a week</Label>
                    <Stepper ariaLabel="nights a week" value={t.per_week} min={1} max={7} onChange={(v) => setTarget(t.key, { per_week: v })} />
                  </div>
                  <div>
                    <Label>Asleep in the bassinet for at least</Label>
                    <Stepper ariaLabel="minutes asleep in the bassinet" value={t.min_minutes} min={15} max={720} step={15} suffix="min" onChange={(v) => setTarget(t.key, { min_minutes: v })} />
                  </div>
                </>
              )}
              {t.kind === "bassinet_stretch" && (
                <div>
                  <Label>One stretch in the bassinet of at least</Label>
                  <Stepper ariaLabel="minutes in one bassinet stretch" value={t.minutes} min={15} max={720} step={15} suffix="min" onChange={(v) => setTarget(t.key, { minutes: v })} />
                  {t.minutes != null && t.minutes >= 60 && <p className={cx(tone.muted, "mt-1.5 text-[13px]")}>{minutesWords(t.minutes)}</p>}
                </div>
              )}
              {t.kind === "protected_window" && (
                <>
                  <div>
                    <Label>Whose window</Label>
                    <div className="flex flex-wrap gap-2">
                      {people.map((p) => (
                        <Chip key={p.email} raised selected={t.member === p.email} onClick={() => setTarget(t.key, { member: p.email })}>
                          {label(p.email)}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label>Nights a week they get it</Label>
                    <Stepper ariaLabel="nights a week they get their window's sleep" value={t.per_week} min={1} max={7} onChange={(v) => setTarget(t.key, { per_week: v })} />
                  </div>
                  <p className={cx(tone.muted, "text-[13px] leading-snug")}>
                    Counted from {t.member === s.me ? "your" : `${memberName(t.member)}'s`} own morning check-ins.
                    {!draft.roster.some((w) => w.member === t.member) && ` Add ${t.member === s.me ? "your" : `${memberName(t.member)}'s`} window to the night roster below, so its nights are known.`}
                  </p>
                </>
              )}
              {t.kind === "custom" && (
                <div>
                  <Label>In your words</Label>
                  <input
                    className={cx(tone.input, at("targets", i) && BAD)}
                    aria-label={`Target ${i + 1}, in your words`}
                    value={t.text}
                    maxLength={GOAL_CUSTOM_MAX}
                    placeholder="Like “calmer bedtimes”"
                    onChange={(e) => setTarget(t.key, { text: e.target.value })}
                  />
                  <p className={cx(tone.muted, "mt-1.5 text-[13px]")}>Maple doesn&apos;t count this one from the log.</p>
                </div>
              )}
              <Problem>{at("targets", i)}</Problem>
            </div>
          ))}
          {draft.targets.length < GOAL_TARGETS_MAX && (
            <div>
              <p className={cx(tone.muted, "mb-2 px-1 text-[13px]")}>{draft.targets.length ? "Add another target" : "Add a target, so there's something to count"}</p>
              <div className="flex flex-wrap gap-2">
                {TARGET_KINDS.map((k) => (
                  <Chip key={k} onClick={() => addTarget(k)} aria-label={`Add a target: ${TARGET_KIND_LABEL[k]}`}>
                    <Icon name="plus" size={16} /> {TARGET_KIND_LABEL[k]}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <Problem>{at("targets")}</Problem>
          <Changed>{theirs("targets") ? `${elsewhere!.who} changed the targets on another phone` : null}</Changed>
        </Section>

        <Section title="Weekly steps" count={draft.steps.length} max={GOAL_STEPS_MAX}>
          {draft.steps.map((st, i) => {
            const problem = at("steps", i);
            return (
            <div key={st.key} className={cx(tone.inset, "space-y-2 px-3.5 py-3")} role="group" aria-label={`Step ${i + 1}`}>
              <div className="flex items-start gap-2">
                <input
                  className={cx(tone.input, "min-w-0 flex-1", problem && (/words/.test(problem) || UNSAFE.test(problem)) && BAD)}
                  aria-label={`Step ${i + 1}`}
                  value={st.title}
                  maxLength={GOAL_STEP_TITLE_MAX}
                  placeholder="Like “bassinet after the 10 PM feed”"
                  onChange={(e) => setStep(st.key, { title: e.target.value })}
                />
                <RemoveButton label={`Remove step ${i + 1}`} onClick={() => edit((d) => ({ ...d, steps: d.steps.filter((x) => x.key !== st.key) }))} />
              </div>
              <label className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cx(tone.label)}>Week of (optional)</span>
                <input type="date" aria-label={`Step ${i + 1}, week of`} value={st.week_of} onChange={(e) => setStep(st.key, { week_of: e.target.value })} className={cx(tone.input, "min-w-0 flex-1 py-2", problem && /week/.test(problem) && BAD)} />
              </label>
              {st.done && <p className={cx(tone.muted, "text-[13px]")}>Done; it stays done when you save.</p>}
              <Problem>{problem}</Problem>
            </div>
            );
          })}
          {draft.steps.length < GOAL_STEPS_MAX && (
            <Chip onClick={addStep}>
              <Icon name="plus" size={16} /> Add a step
            </Chip>
          )}
          <Problem>{at("steps")}</Problem>
          <Changed>{theirs("steps") ? `${elsewhere!.who} changed the steps on another phone` : null}</Changed>
        </Section>

        <Section title="Night roster" count={draft.roster.length} max={ROSTER_MAX}>
          {draft.roster.length === 0 && <p className={cx(tone.muted, "px-1 text-[13px] leading-snug")}>Who sleeps when: a protected window for each adult, like 10 PM to 2 AM while the other is on.</p>}
          {draft.roster.map((w, i) => {
            const len = windowMinutes(w.from, w.to);
            return (
              <div key={w.key} className={cx(tone.inset, "space-y-3 px-3.5 py-3")} role="group" aria-label={`Window ${i + 1}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className={cx(tone.heading, "text-[15px]")}>Window {i + 1}</p>
                  <RemoveButton label={`Remove window ${i + 1}`} onClick={() => edit((d) => ({ ...d, roster: d.roster.filter((x) => x.key !== w.key) }))} />
                </div>
                <div>
                  <Label>Who sleeps</Label>
                  <div role="group" aria-label={`Window ${i + 1}: who sleeps`} className="flex flex-wrap gap-2">
                    {people.map((p) => (
                      <Chip key={p.email} raised selected={w.member === p.email} onClick={() => setWindow(w.key, { member: p.email })}>
                        {label(p.email)}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <label className="min-w-[8.5rem] flex-1">
                    <span className={cx(tone.label, "mb-1.5 block")}>From</span>
                    <input type="time" aria-label={`Window ${i + 1} from`} value={w.from} onChange={(e) => setWindow(w.key, { from: e.target.value })} className={cx(tone.input, "min-w-0 tabular-nums", at("roster", i) && BAD)} />
                  </label>
                  <label className="min-w-[8.5rem] flex-1">
                    <span className={cx(tone.label, "mb-1.5 block")}>To</span>
                    <input type="time" aria-label={`Window ${i + 1} to`} value={w.to} onChange={(e) => setWindow(w.key, { to: e.target.value })} className={cx(tone.input, "min-w-0 tabular-nums", at("roster", i) && BAD)} />
                  </label>
                </div>
                <div>
                  <Label>Which nights</Label>
                  <div role="group" aria-label={`Window ${i + 1}: which nights`} className="flex flex-wrap gap-1.5">
                    {WEEKDAY_SHORT.map((day, n) => (
                      <Chip
                        key={day}
                        raised
                        className="px-3"
                        selected={w.nights.includes(n)}
                        onClick={() => setWindow(w.key, { nights: w.nights.includes(n) ? w.nights.filter((x) => x !== n) : [...w.nights, n] })}
                      >
                        {day}
                      </Chip>
                    ))}
                  </div>
                  <p className={cx(tone.muted, "mt-1.5 text-[13px]")}>
                    {nightsLabel(w.nights).replace(/^./, (c) => c.toUpperCase())}
                    {len ? ` · ${minutesWords(len)} on the clock` : ""}
                  </p>
                  <p className={cx(tone.faint, "mt-1 text-[13px] leading-snug")}>{nightWords(w)}</p>
                </div>
                <div>
                  <Label optional>Feeds in this window</Label>
                  <div role="group" aria-label={`Window ${i + 1}: feeds in it`} className="flex flex-wrap gap-2">
                    {WINDOW_COVERS.map((c) => (
                      <Chip key={c} raised selected={w.covers === c} onClick={() => setWindow(w.key, { covers: w.covers === c ? null : c })}>
                        {COVERS_LABEL[c]}
                      </Chip>
                    ))}
                  </div>
                  <p className={cx(tone.muted, "mt-1.5 text-[13px] leading-snug")}>{w.covers ? coversHint(w.covers, v) : `How ${v.name}'s feeds are covered while ${w.member === s.me ? "you sleep" : `${memberName(w.member)} sleeps`}, if one falls in it.`}</p>
                </div>
                <Problem>{at("roster", i)}</Problem>
                <Changed>{w.id && elsewhere?.windows.has(w.id) ? `${elsewhere.who} changed this: ${elsewhere.windows.get(w.id)}` : null}</Changed>
              </div>
            );
          })}
          {draft.roster.length < ROSTER_MAX && (
            <Chip onClick={addWindow}>
              <Icon name="plus" size={16} /> Add a window
            </Chip>
          )}
          <Problem>{at("roster")}</Problem>
          <Changed>{theirs("roster") && !draft.roster.some((w) => w.id && elsewhere?.windows.has(w.id)) ? `${elsewhere!.who} changed the night roster on another phone` : null}</Changed>
        </Section>

        <Problem>{at("form")}</Problem>
        <ContextNote>Maple counts what&apos;s logged against each target, week by week, with how many nights each count is out of. A hard night is just counted.</ContextNote>
      </div>
    </Sheet>
  );
}
