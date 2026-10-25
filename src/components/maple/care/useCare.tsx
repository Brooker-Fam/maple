"use client";

import { useCallback, useMemo, useRef } from "react";
import {
  aheadOfSlot,
  careTime,
  countedAs,
  crisisToday,
  doseNotes,
  nextUnits,
  oneOffNotes,
  oneTapDecision,
  planActive,
  planView,
  scoreScreen,
  sortPlans,
  suggestAckKey,
  suggestFullCheckin,
  todayCheckin,
  unitsKnown,
  type PlanView,
} from "@/lib/maple/care";
import { CHECKIN_SAVED, MOM_TIER_LABEL, type Assessment, type MoodTag } from "@/lib/maple/guidelines";
import { adminActsAs } from "@/lib/maple/insights";
import { formatTime, formatTimeNear } from "@/lib/maple/time";
import { formatTemp } from "@/lib/maple/units";
import type {
  CareAccess,
  CareEntry,
  CareEntryInput,
  CarePlan,
  CareSettings,
  CareState,
  DoseEntry,
  DoseResult,
  MoodDataByKind,
  MoodEntry,
  OneTapAsk,
  PlanInput,
  PlanStatus,
} from "@/lib/maple/types";
import { ApiError, useMaple, useNow, type ToastAction } from "../useMaple";

/**
 * Mom's area for the signed-in reader, from the care part of Maple's state:
 * her plans as the engine reads them, and every write (through the outbox,
 * like Maple's entries). Null when the reader can't read anything there, so
 * a component that gets null shows nothing about her.
 *
 * Actions show their own toasts, as useMaple's log() does: a saved dose says
 * when the next one is OK by her schedule, with "2/5/15 min earlier" and
 * Undo; a deleted or stopped plan offers Undo. When one didn't happen they
 * reject with the server's words (err.message: the plan sheet's validation
 * copy, "Matt changed this plan a moment ago. Here's the latest."), except
 * logDose and tookIt, which resolve with the ask instead (only a likely
 * duplicate asks: early or over the limit saves, and the toast says so).
 */

export type CareActions = {
  patchPerson(p: Partial<{ shared_with: string[]; settings: CareSettings }>): Promise<void>;
  savePlan(input: PlanInput, expectUpdatedAt?: string): Promise<CarePlan>;
  deletePlan(id: number): Promise<void>;
  stopPlan(id: number): Promise<void>;
  /** "Take it again": a finished plan back on her list, with its history. */
  resumePlan(id: number): Promise<void>;
  tookIt(planId: number): Promise<"saved" | { ask: OneTapAsk }>;
  logDose(i: {
    planId?: number;
    oneOff?: { name: string; dose?: string; private?: boolean };
    at: string;
    units?: number;
    dose?: string;
    note?: string;
    skipped?: boolean;
    allowDuplicate?: boolean;
  }): Promise<DoseResult>;
  /** `quiet`: no "Saved" toast (a question's Asked tick and its answer save as you go). */
  editEntry(id: number, patch: object, expectUpdatedAt: string, opts?: { quiet?: boolean }): Promise<void>;
  deleteEntry(id: number): Promise<void>;
  restoreEntry(id: number): Promise<void>;
  logTemp(tempC: number, at: string): Promise<DoseResult>;
  addQuestion(text: string, priv?: boolean): Promise<void>;
  /** One tap saves (toast CHECKIN_SAVED). Resolves with the entry; its id is temporary (negative) while it waits on this phone, and every action below takes either. */
  checkin(level: 1 | 2 | 3 | 4 | 5): Promise<MoodEntry>;
  /** The chips, the note, or a changed answer ("Change"): shown at once, saved as she goes with no toast; rejects with the server's words. */
  updateCheckin(id: number, p: { level?: 1 | 2 | 3 | 4 | 5; tags?: MoodTag[]; note?: string }): Promise<void>;
  /** A hard delete (after "Delete this check-in for good?"): no Undo. */
  deleteMood(id: number): Promise<void>;
  /**
   * Save the fuller check-in's answers (the scores are worked out again on
   * the server). With `id`, update that one instead: save at item 9 so the
   * crisis strip holds even if the app closes, then again at the end.
   * "Stop here" saves what's answered, which comes back complete: false.
   */
  saveScreen(d: Pick<MoodDataByKind["screen"], "phq9" | "gad7" | "difficulty" | "item9_ever">, opts?: { id?: number }): Promise<MoodEntry>;
  /** "Not now" on a fuller check-in suggestion: gone for good (the visit one comes back only for a different visit date). */
  dismissSuggestion(kind: "day14" | "visit"): Promise<void>;
  moveFromMaple(entryId: number, planId?: number): Promise<void>;
};

export type UseCare = {
  state: CareState;
  self: boolean;
  access: CareAccess;
  /** memberName(person): never a hard-coded name. */
  name: string;
  /** Active, visible plans in sortPlans order. */
  plans: PlanView[];
  finished: PlanView[];
  /** The first Show on Today plan (the Lantern shows it too). */
  todayLine: { view: PlanView; more: number } | null;
  lanternLine: string | null;
  doses(planId: number, days: number): CareEntry[];
  /**
   * Hers only. `checkins` newest first (the last 14 days); `todayCheckin` her
   * newest one today ("Today: Up and down · Change"); `crisisToday` keeps
   * CrisisStrip up until local midnight.
   */
  mood?: {
    checkins: Extract<MoodEntry, { kind: "checkin" }>[];
    todayCheckin: Extract<MoodEntry, { kind: "checkin" }> | null;
    latestScreen: Extract<MoodEntry, { kind: "screen" }> | null;
    crisisToday: boolean;
    suggestion: "day14" | "visit" | null;
  };
  act: CareActions;
};

/** Network down or a server hiccup: keep it and retry, unlike a 4xx. */
const isTransient = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;

function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

// Her check-ins save one after another, so a chip tapped while "Low" is still
// on its way goes out after it (to the saved id), and two quick taps reach the
// server in the order she made them. Shared by every useCare() on the page
// (the check-in card, the fuller check-in and its results each call it), like
// useMaple's temporary ids.
const moodChain: { current: Promise<unknown> } = { current: Promise.resolve() };
/** Temporary id → saved id, for a caller still holding the temporary one. */
const moodSaved = new Map<number, number>();

/** "Call Poison Help now: Ibuprofen: over your daily limit" (a note, in one toast line). */
const noteLine = (n: Assessment) => `${n.label ?? MOM_TIER_LABEL[n.tier]}: ${n.title}`;

export function useCare(): UseCare | null {
  const { state, api, toast, now: clock, refresh, units, care: store } = useMaple();
  // Statuses move with the clock ("OK since", "Last one 2 h ago"), not only with polls.
  const now = useNow(30_000);
  const care = state?.care ?? null;
  const tz = state?.baby.timezone ?? "America/New_York";

  /** Who the server credits this reader's writes to: the admin login logs as its admin_as member. */
  const viewerId = useMemo(() => {
    if (!state) return "";
    if (state.me.email !== "admin") return state.me.email;
    return adminActsAs(state.baby, state.members)?.email ?? "admin";
  }, [state]);

  const derived = useMemo(() => {
    if (!care || !state) return null;
    const dosesBy = new Map<number, DoseEntry[]>();
    for (const e of care.entries) {
      if (e.kind !== "dose" || e.med_id == null) continue;
      const list = dosesBy.get(e.med_id) ?? [];
      list.push(e);
      dosesBy.set(e.med_id, list);
    }
    const self = care.person.self;
    const ctx = { now, tz, self, members: state.members, me: viewerId, name: care.person.name, settings: care.settings };
    const views = care.plans.map((plan) => {
      const doses = dosesBy.get(plan.id) ?? [];
      return planView(plan, doses, { ...ctx, pending: doses.some((d) => d.pending) }, viewerId);
    });
    const plans = sortPlans(views.filter((v) => planActive(v.plan, now, tz)));
    const finished = views
      .filter((v) => !planActive(v.plan, now, tz))
      .sort((a, b) => (b.plan.stopped_at ?? b.plan.course_end ?? "").localeCompare(a.plan.stopped_at ?? a.plan.course_end ?? ""));
    const onToday = plans.filter((v) => v.plan.show_on_today);
    const lantern = onToday[0];
    const moodRows = care.mood ? [...care.mood].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id) : null;
    const latestScreen = (moodRows?.find((m) => m.kind === "screen") ?? null) as Extract<MoodEntry, { kind: "screen" }> | null;
    const mood = moodRows
      ? {
          checkins: moodRows.filter((m): m is Extract<MoodEntry, { kind: "checkin" }> => m.kind === "checkin"),
          todayCheckin: todayCheckin(moodRows, now, tz),
          latestScreen,
          crisisToday: crisisToday(moodRows, now, tz),
          suggestion: suggestFullCheckin({ now, tz, bornAt: state.baby.born_at, settings: care.settings, lastScreenAt: latestScreen?.at ?? null }),
        }
      : undefined;
    return {
      dosesBy,
      plans,
      finished,
      todayLine: onToday.length ? { view: onToday[0], more: onToday.length - 1 } : null,
      // On anyone else's Lantern, whose medicine it is: the rest of that screen is all Maple.
      lanternLine: lantern ? (self ? lantern.line : `${care.person.name}: ${lantern.line}`) : null,
      mood,
    };
  }, [care, state, now, tz, viewerId]);

  // Actions read the latest state when they run, not the render they were made in.
  const careRef = useRef(care);
  careRef.current = care;
  const membersRef = useRef(state?.members ?? []);
  membersRef.current = state?.members ?? [];

  const done = useCallback(() => void refresh(), [refresh]);

  /** The server's words for a failed write (or a plain line for the network). */
  const fail = useCallback((e: unknown, fallback: string): Error => (e instanceof Error ? e : new Error(fallback)), []);

  const call = useCallback(
    async <T,>(path: string, init: RequestInit): Promise<T> => {
      try {
        return await store.track(() => api<T>(path, init));
      } finally {
        done();
      }
    },
    [api, done, store]
  );

  const planOf = useCallback((id: number) => careRef.current?.plans.find((p) => p.id === id) ?? null, []);
  const dosesOf = useCallback(
    (planId: number) => (careRef.current?.entries ?? []).filter((e): e is DoseEntry => e.kind === "dose" && e.med_id === planId),
    []
  );

  /** The engine's status for a plan right now, from the latest state (or from `doses` when given). */
  const statusOf = useCallback(
    (plan: CarePlan, doses: DoseEntry[] = dosesOf(plan.id)): PlanStatus => {
      const c = careRef.current;
      return planView(plan, doses, { now: clock(), tz, self: !!c?.person.self, members: membersRef.current, me: viewerId, name: c?.person.name ?? "mom", settings: c?.settings ?? {} }).status;
    },
    [clock, dosesOf, tz, viewerId]
  );

  /** "Ibuprofen at 3:05 AM · OK after 9:05 AM" (or the unknown, daily or times variant). */
  const doseText = useCallback(
    (plan: CarePlan | null, entry: DoseEntry): string => {
      const name = entry.data.name;
      if (entry.data.skipped) return `${name} skipped`;
      const base = `${name} at ${formatTime(entry.at, tz)}`;
      if (!plan) return base;
      // The saved dose plus what's on the server: never this phone's early copy (a temporary id) as well.
      const st = statusOf(plan, [...dosesOf(plan.id).filter((d) => (d.id > 0 || d.pending) && d.id !== entry.id), entry]);
      const t = clock();
      if ((st.state === "wait" || st.state === "at_limit") && st.nextOkAt) return `${base} · OK after ${careTime(st.nextOkAt, t, tz)}`;
      if (plan.schedule.type === "daily") return `${base} · ${st.today.length} of ${plan.schedule.per_day} today`;
      if (st.state === "slot_next" && st.nextSlotAt) return `${base} · next ${careTime(st.nextSlotAt, t, tz)}`;
      return base;
    },
    [clock, dosesOf, statusOf, tz]
  );

  const patchEntries = useCallback((fn: (entries: CareEntry[]) => CareEntry[]) => store.patch((c) => ({ ...c, entries: fn(c.entries) })), [store]);

  const restoreEntry = useCallback<CareActions["restoreEntry"]>(
    async (id) => {
      try {
        const { entry } = await call<{ entry: CareEntry }>(`/api/maple/care/entries/restore?id=${id}`, { method: "POST" });
        patchEntries((es) => [entry, ...es.filter((e) => e.id !== id)]);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't restore", { tone: "error" });
        throw fail(e, "Couldn't restore");
      }
    },
    [call, fail, patchEntries, toast]
  );

  /** "Matt removed this dose, so your change wasn't saved." (someone else's delete got there first). */
  const goneLine = useCallback((e: unknown, saving: boolean, dose = false): string | null => {
    if (!(e instanceof ApiError) || e.status !== 404) return null;
    const b = e.body as { reason?: string; deleted_by?: string | null } | null;
    if (b?.reason !== "discarded") return null;
    const m = membersRef.current.find((x) => x.email === b.deleted_by);
    const who = b.deleted_by === viewerId ? "You" : m?.display_name || (b.deleted_by && b.deleted_by !== "admin" ? b.deleted_by.split("@")[0] : null);
    const what = saving ? ", so your change wasn't saved." : " already.";
    const it = dose ? "this dose" : "this";
    return who ? `${who} removed ${it}${what}` : `${dose ? "This dose" : "This"} was removed on another device${what}`;
  }, [viewerId]);

  const deleteEntry = useCallback<CareActions["deleteEntry"]>(
    async (id) => {
      // Still on this phone only: just drop it.
      if (store.unqueue(id)) {
        toast("Removed");
        return;
      }
      if (id < 0) {
        toast("One sec, that's still saving", { tone: "info" });
        return;
      }
      const before = careRef.current?.entries.find((e) => e.id === id);
      patchEntries((es) => es.filter((e) => e.id !== id));
      try {
        await call(`/api/maple/care/entries?id=${id}`, { method: "DELETE" });
        toast("Deleted", { undo: () => void restoreEntry(id).catch(() => {}) });
      } catch (e) {
        const gone = goneLine(e, false);
        if (gone) toast(gone, { tone: "info" });
        else {
          if (before) patchEntries((es) => [before, ...es]);
          toast(e instanceof Error ? e.message : "Couldn't delete", { tone: "error" });
          throw fail(e, "Couldn't delete");
        }
      }
    },
    [call, fail, goneLine, patchEntries, restoreEntry, store, toast]
  );

  const editEntry = useCallback<CareActions["editEntry"]>(
    async (id, patch, expectUpdatedAt, opts) => {
      if (id < 0) {
        toast("One sec, that's still saving", { tone: "info" });
        return;
      }
      try {
        const res = await call<{ entry: CareEntry; notes: Assessment[] }>(`/api/maple/care/entries?id=${id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...patch, expect_updated_at: expectUpdatedAt }),
        });
        patchEntries((es) => es.map((e) => (e.id === id ? res.entry : e)));
        const note = res.notes.find((n) => n.tier !== "today");
        if (!opts?.quiet) toast(note ? `Saved. ${noteLine(note)}` : "Saved", { tone: note ? "info" : "ok" });
      } catch (e) {
        const gone = goneLine(e, true, careRef.current?.entries.find((x) => x.id === id)?.kind === "dose");
        if (gone) {
          patchEntries((es) => es.filter((x) => x.id !== id));
          toast(gone, { tone: "info" });
          return;
        }
        throw fail(e, "Couldn't save");
      }
    },
    [call, fail, goneLine, patchEntries, toast]
  );

  /** The toast after a dose saves: when the next is OK, any note, "2/5/15 min earlier" and Undo. */
  const doseToast = useCallback(
    (plan: CarePlan | null, entry: DoseEntry, notes: Assessment[]) => {
      // A count left out on a plan that counts units: say what it counted as, so a wrong one gets fixed.
      const counted = plan && !entry.data.skipped ? countedAs(plan, entry.data.units) : null;
      // An "At set times" dose more than an hour early counts for the next time: say which.
      const slot = plan && !entry.data.skipped ? aheadOfSlot(plan, dosesOf(plan.id).filter((d) => d.id !== entry.id && d.at !== entry.at), new Date(entry.at), tz) : null;
      const text = `${doseText(plan, entry)}${counted ? ` · counted as ${counted}` : ""}${slot ? ` · for the ${formatTimeNear(Date.parse(slot), Date.parse(entry.at), tz)} time` : ""}`;
      const urgent = notes.find((n) => n.tier === "now" || n.tier === "emergency") ?? notes.find((n) => n.tier === "nudge");
      const recorded = Date.parse(entry.at);
      const chips: ToastAction[] = entry.data.skipped
        ? []
        : [2, 5, 15].map((n) => {
            const to = recorded - n * 60_000;
            return {
              label: `${n} min earlier`,
              sub: formatTimeNear(to, recorded, tz),
              ariaLabel: `${entry.data.name} ${n} minutes earlier, at ${formatTime(to, tz)}`,
              onClick: () => void editEntry(entry.id, { at: new Date(to).toISOString() }, entry.updated_at).catch((e) => toast(e.message, { tone: "error" })),
            };
          });
      // A call-now note carries its whole text (who to call, the number): there's no sheet to read it in after a one-tap.
      const urgentText = urgent ? `${noteLine(urgent)}${urgent.tier === "now" || urgent.tier === "emergency" ? `. ${urgent.body}` : ""}` : "";
      toast(urgent ? `${text}. ${urgentText}` : text, {
        tone: urgent ? "info" : "ok",
        icon: "pill",
        actions: entry.id > 0 ? chips : undefined,
        undo: () => void deleteEntry(entry.id).catch(() => {}),
      });
    },
    [deleteEntry, doseText, dosesOf, editEntry, toast, tz]
  );

  const logDose = useCallback<CareActions["logDose"]>(
    async (i) => {
      const c = careRef.current;
      if (!c) throw new Error("That page isn't available.");
      const plan = i.planId != null ? planOf(i.planId) : null;
      if (i.planId != null && !plan) throw new Error("That medicine isn't on the list anymore.");
      const name = plan ? plan.name : i.oneOff?.name?.trim() ?? "";
      const nowIso = clock().toISOString();
      const input: CareEntryInput = {
        kind: "dose",
        at: i.at,
        med_id: plan?.id ?? null,
        data: { name, dose: i.dose ?? i.oneOff?.dose ?? null, units: i.units ?? null, unit: plan?.limit_unit ?? null, ...(i.skipped ? { skipped: true } : {}) },
        note: i.note ?? null,
        private: plan ? false : i.oneOff?.private === true,
        client_id: newClientId(),
        ...(i.allowDuplicate ? { allow_duplicate: true } : {}),
      };
      const early: DoseEntry = {
        id: store.tempId(),
        kind: "dose",
        med_id: input.med_id ?? null,
        at: i.at,
        data: { ...input.data, dose: input.data.dose ?? plan?.dose_text ?? null },
        note: input.note ?? null,
        private: input.private ?? false,
        created_by: viewerId,
        updated_by: null,
        source: "web",
        created_at: nowIso,
        updated_at: nowIso,
      };
      patchEntries((es) => [early, ...es]);
      const settings = c.settings;
      const nctx = { name: c.person.name, self: c.person.self, settings, now: clock(), tz };
      try {
        const res = await call<DoseResult>("/api/maple/care/entries", { method: "POST", body: JSON.stringify(input) });
        patchEntries((es) => {
          const rest = es.filter((e) => e.id !== early.id && e.id !== res.entry?.id);
          return res.entry && (res.created || res.deduped) ? [res.entry, ...rest] : rest;
        });
        if ((res.created || res.deduped) && res.entry?.kind === "dose") doseToast(plan, res.entry, res.notes);
        return res;
      } catch (e) {
        patchEntries((es) => es.filter((x) => x.id !== early.id));
        if (isTransient(e)) {
          // Kept on this phone: it syncs when the connection is back, and its line says so meanwhile.
          store.queue(input, early);
          toast("Saved on this phone · will sync when you're back online", { tone: "info" });
          const notes = plan ? doseNotes(plan, dosesOf(plan.id), { at: i.at, units: i.units, skipped: i.skipped }, nctx) : oneOffNotes(name, c.plans, nctx);
          return { created: true, entry: { ...early, pending: true }, notes };
        }
        throw fail(e, "Couldn't save that");
      }
    },
    [call, clock, dosesOf, doseToast, fail, patchEntries, planOf, store, toast, tz, viewerId]
  );

  const tookIt = useCallback<CareActions["tookIt"]>(
    async (planId) => {
      const plan = planOf(planId);
      if (!plan) throw new Error("That medicine isn't on the list anymore.");
      const t = clock();
      const doses = dosesOf(planId);
      const status = statusOf(plan);
      const decision = oneTapDecision(plan, status, doses, t, viewerId);
      if (decision !== "save") return decision;
      const res = await logDose({ planId, at: t.toISOString(), ...(unitsKnown(plan) && plan.max_24h != null && plan.limit_unit !== "doses" ? { units: nextUnits(plan) } : {}) });
      if (!res.created && !res.deduped) {
        // The other phone, Siri or an assistant got there first: the ask sheet instead of the toast.
        const dup = res.possible_duplicate;
        if (dup) return { ask: { reason: "recent", by: dup.created_by, at: dup.at } };
        return { ask: { reason: res.reason ?? "recent" } };
      }
      return "saved";
    },
    [clock, dosesOf, logDose, planOf, statusOf, viewerId]
  );

  const patchPlan = useCallback((plan: CarePlan) => store.patch((c) => ({ ...c, plans: [...c.plans.filter((p) => p.id !== plan.id), plan].sort((a, b) => a.sort - b.sort || a.id - b.id) })), [store]);

  const savePlan = useCallback<CareActions["savePlan"]>(
    async (input, expectUpdatedAt) => {
      try {
        if (input.id != null) {
          const { id, ...patch } = input;
          const { plan } = await call<{ plan: CarePlan }>(`/api/maple/care/meds?id=${id}`, {
            method: "PATCH",
            body: JSON.stringify({ ...patch, ...(expectUpdatedAt ? { expect_updated_at: expectUpdatedAt } : {}) }),
          });
          patchPlan(plan);
          return plan;
        }
        const { plan } = await call<{ plan: CarePlan }>("/api/maple/care/meds", { method: "POST", body: JSON.stringify({ ...input, client_id: input.client_id ?? newClientId() }) });
        patchPlan(plan);
        return plan;
      } catch (e) {
        // Lost a race: show the latest, and say so (the sheet shows err.message).
        const latest = e instanceof ApiError ? (e.body as { plan?: CarePlan } | null)?.plan : undefined;
        if (latest) patchPlan(latest);
        throw fail(e, "Couldn't save that");
      }
    },
    [call, fail, patchPlan]
  );

  const planPatch = useCallback(
    async (id: number, body: Record<string, unknown>) => {
      const { plan } = await call<{ plan: CarePlan }>(`/api/maple/care/meds?id=${id}`, { method: "PATCH", body: JSON.stringify(body) });
      patchPlan(plan);
      return plan;
    },
    [call, patchPlan]
  );

  const stopPlan = useCallback<CareActions["stopPlan"]>(
    async (id) => {
      try {
        const plan = await planPatch(id, { stopped: true });
        toast(`${plan.name} stopped`, { undo: () => void planPatch(id, { stopped: false }).catch((e) => toast(e.message, { tone: "error" })) });
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't stop it", { tone: "error" });
        throw fail(e, "Couldn't stop it");
      }
    },
    [fail, planPatch, toast]
  );

  const resumePlan = useCallback<CareActions["resumePlan"]>(
    async (id) => {
      try {
        const plan = await planPatch(id, { stopped: false });
        toast(`${plan.name} is back on the list`, { undo: () => void planPatch(id, { stopped: true }).catch((e) => toast(e.message, { tone: "error" })) });
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't do that", { tone: "error" });
        throw fail(e, "Couldn't do that");
      }
    },
    [fail, planPatch, toast]
  );

  const deletePlan = useCallback<CareActions["deletePlan"]>(
    async (id) => {
      try {
        const { plan } = await call<{ plan: CarePlan }>(`/api/maple/care/meds?id=${id}`, { method: "DELETE" });
        store.patch((c) => ({ ...c, plans: c.plans.filter((p) => p.id !== id) }));
        toast(`Deleted ${plan.name}`, { undo: () => void planPatch(id, { deleted: false }).catch((e) => toast(e.message, { tone: "error" })) });
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't delete", { tone: "error" });
        throw fail(e, "Couldn't delete");
      }
    },
    [call, fail, planPatch, store, toast]
  );

  const patchPerson = useCallback<CareActions["patchPerson"]>(
    async (p) => {
      // At once on this phone: a switch or a dismissed banner shouldn't wait for the server.
      store.patch((c) => ({
        ...c,
        ...(p.shared_with ? { shared_with: p.shared_with } : {}),
        ...(p.settings ? { settings: { ...c.settings, ...p.settings, care_team: { ...c.settings.care_team, ...p.settings.care_team }, acks: { ...c.settings.acks, ...p.settings.acks } } } : {}),
      }));
      try {
        await call("/api/maple/care/person", { method: "PATCH", body: JSON.stringify(p) });
      } catch (e) {
        throw fail(e, "Couldn't save that");
      }
    },
    [call, fail, store]
  );

  const logTemp = useCallback<CareActions["logTemp"]>(
    async (tempC, at) => {
      const input: CareEntryInput = { kind: "temp", at, data: { temp_c: tempC }, client_id: newClientId() };
      try {
        const res = await call<DoseResult>("/api/maple/care/entries", { method: "POST", body: JSON.stringify(input) });
        const entry = res.entry;
        if (entry) patchEntries((es) => [entry, ...es.filter((e) => e.id !== entry.id)]);
        const note = res.notes[0];
        const text = `${formatTemp(tempC, units)} at ${formatTime(at, tz)}`;
        toast(note ? `${text}. ${noteLine(note)}` : text, { tone: note ? "info" : "ok", undo: entry ? () => void deleteEntry(entry.id).catch(() => {}) : undefined });
        return res;
      } catch (e) {
        if (isTransient(e)) {
          const early = { id: store.tempId(), kind: "temp", med_id: null, at, data: { temp_c: tempC }, note: null, private: false, created_by: viewerId, updated_by: null, source: "web", created_at: at, updated_at: at } as CareEntry;
          store.queue(input, early);
          toast("Saved on this phone · will sync when you're back online", { tone: "info" });
          return { created: true, entry: { ...early, pending: true }, notes: [] };
        }
        throw fail(e, "Couldn't save that");
      }
    },
    [call, deleteEntry, fail, patchEntries, store, toast, tz, units, viewerId]
  );

  const addQuestion = useCallback<CareActions["addQuestion"]>(
    async (text, priv) => {
      const input: CareEntryInput = { kind: "question", at: clock().toISOString(), data: {}, note: text, private: priv === true, client_id: newClientId() };
      try {
        const res = await call<DoseResult>("/api/maple/care/entries", { method: "POST", body: JSON.stringify(input) });
        const entry = res.entry;
        if (entry) patchEntries((es) => [entry, ...es.filter((e) => e.id !== entry.id)]);
        toast("Added", { undo: entry ? () => void deleteEntry(entry.id).catch(() => {}) : undefined });
      } catch (e) {
        if (isTransient(e)) {
          const at = input.at;
          const early = { id: store.tempId(), kind: "question", med_id: null, at, data: {}, note: text, private: priv === true, created_by: viewerId, updated_by: null, source: "web", created_at: at, updated_at: at } as CareEntry;
          store.queue(input, early);
          toast("Saved on this phone · will sync when you're back online", { tone: "info" });
          return;
        }
        throw fail(e, "Couldn't save that");
      }
    },
    [call, clock, deleteEntry, fail, patchEntries, store, toast, viewerId]
  );

  const patchMood = useCallback((fn: (m: MoodEntry[]) => MoodEntry[]) => store.patch((c) => (c.mood ? { ...c, mood: fn(c.mood) } : c)), [store]);

  const serialMood = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = moodChain.current.then(fn, fn);
    moodChain.current = run.catch(() => {});
    return run;
  }, []);
  const moodTarget = useCallback((id: number) => (id > 0 ? id : moodSaved.get(id) ?? id), []);
  /** The entry as this phone has it (the render may lag a write by a tick), under its saved id. */
  const moodNow = useCallback((id: number, target: number) => {
    const m = careRef.current?.mood?.find((x) => x.id === target || x.id === id);
    return m ? ({ ...m, id: target } as MoodEntry) : null;
  }, []);

  /** A new check-in or fuller check-in: on screen at once, then saved, or kept on this phone while offline. */
  const createMood = useCallback(
    async (kind: MoodEntry["kind"], data: Record<string, unknown>): Promise<{ entry: MoodEntry; queued: boolean }> => {
      const at = clock().toISOString();
      const input = { kind, at, data, client_id: newClientId() };
      const shown = kind === "screen" ? scoreScreen(data as Parameters<typeof scoreScreen>[0]) : data;
      const temp = { id: store.tempId(), kind, at, data: shown, note: null, created_at: at, updated_at: at } as MoodEntry;
      patchMood((m) => [temp, ...m]);
      return serialMood(async () => {
        try {
          const { entry } = await call<{ entry: MoodEntry }>("/api/maple/care/mood", { method: "POST", body: JSON.stringify(input) });
          moodSaved.set(temp.id, entry.id);
          // Keep what she changed on this phone meanwhile (a chip, the note): that change goes out next.
          patchMood((m) => {
            const local = m.find((x) => x.id === temp.id);
            const saved = local ? ({ ...entry, data: local.data, note: local.note } as MoodEntry) : entry;
            return [saved, ...m.filter((x) => x.id !== temp.id && x.id !== entry.id)];
          });
          return { entry, queued: false };
        } catch (e) {
          if (isTransient(e)) {
            const kept = moodNow(temp.id, temp.id) ?? temp;
            patchMood((m) => m.map((x) => (x.id === temp.id ? ({ ...x, pending: true } as MoodEntry) : x)));
            store.queueMood({ ...input, data: kept.data, ...(kept.note ? { note: kept.note } : {}) }, kept);
            return { entry: { ...kept, pending: true }, queued: true };
          }
          patchMood((m) => m.filter((x) => x.id !== temp.id));
          throw fail(e, "Couldn't save that");
        }
      });
    },
    [call, clock, fail, moodNow, patchMood, serialMood, store]
  );

  /**
   * A change to one of hers: shown at once (the crisis strip can't wait for
   * the server), then sent; folded into one still waiting on this phone, or
   * kept for later while offline. `data` merges into what's saved. Resolves
   * with the entry as it now shows (pending while it waits on this phone).
   */
  const changeMood = useCallback(
    (id: number, patch: { data?: Record<string, unknown>; note?: string | null }, apply: (m: MoodEntry) => MoodEntry): Promise<MoodEntry> => {
      patchMood((m) => m.map((x) => (x.id === id || x.id === moodTarget(id) ? apply(x) : x)));
      return serialMood(async () => {
        const target = moodTarget(id);
        if (target !== id) patchMood((m) => m.map((x) => (x.id === target ? apply(x) : x)));
        const base = moodNow(id, target);
        if (target < 0) {
          if (!base) throw new Error("That check-in isn't here anymore.");
          store.queueMood(patch, apply(base));
          return { ...apply(base), pending: true } as MoodEntry;
        }
        try {
          const { entry } = await call<{ entry: MoodEntry }>(`/api/maple/care/mood?id=${target}`, { method: "PATCH", body: JSON.stringify(patch) });
          patchMood((m) => m.map((x) => (x.id === target ? entry : x)));
          return entry;
        } catch (e) {
          if (isTransient(e) && base) {
            store.queueMood(patch, apply(base), target);
            return { ...apply(base), pending: true } as MoodEntry;
          }
          // Deleted on her other phone meanwhile: it's gone here too.
          if (e instanceof ApiError && e.status === 404) patchMood((m) => m.filter((x) => x.id !== target));
          throw fail(e, "Couldn't save that");
        }
      });
    },
    [call, fail, moodNow, moodTarget, patchMood, serialMood, store]
  );

  const checkin = useCallback<CareActions["checkin"]>(
    async (level) => {
      try {
        const { entry, queued } = await createMood("checkin", { level });
        toast(queued ? "Saved on this phone · will sync when you're back online" : CHECKIN_SAVED, { tone: queued ? "info" : "ok" });
        return entry;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
        throw e;
      }
    },
    [createMood, toast]
  );

  const updateCheckin = useCallback<CareActions["updateCheckin"]>(
    async (id, p) => {
      const data: Record<string, unknown> = { ...(p.level != null ? { level: p.level } : {}), ...(p.tags ? { tags: p.tags } : {}) };
      const note = p.note === undefined ? undefined : p.note.trim() || null;
      const patch = { ...(Object.keys(data).length ? { data } : {}), ...(note !== undefined ? { note } : {}) };
      if (!Object.keys(patch).length) return;
      await changeMood(id, patch, (m) =>
        m.kind === "checkin"
          ? ({
              ...m,
              // Like the server: once harm_self was ticked, harm_ever holds the day's crisis strip.
              data: { ...m.data, ...data, ...(m.data.harm_ever || p.tags?.includes("harm_self") ? { harm_ever: true } : {}) },
              ...(note !== undefined ? { note } : {}),
            } as MoodEntry)
          : m
      );
    },
    [changeMood]
  );

  const deleteMood = useCallback<CareActions["deleteMood"]>(
    (id) =>
      serialMood(async () => {
        const target = moodTarget(id);
        // Still only on this phone: dropping it is the whole delete.
        if (store.unqueueMood(target)) {
          toast("Deleted");
          return;
        }
        if (target < 0) {
          // Its save failed and it's already off the screen.
          patchMood((m) => m.filter((x) => x.id !== target));
          toast("Deleted");
          return;
        }
        const before = moodNow(id, target);
        patchMood((m) => m.filter((x) => x.id !== target && x.id !== id));
        try {
          await call(`/api/maple/care/mood?id=${target}`, { method: "DELETE" });
          toast("Deleted");
        } catch (e) {
          // Already gone (her other phone): that's what she asked for.
          if (e instanceof ApiError && e.status === 404) {
            toast("Deleted");
            return;
          }
          if (before) patchMood((m) => [before, ...m].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
          const msg = isTransient(e) ? "Couldn't delete that: you're offline" : e instanceof Error ? e.message : "Couldn't delete";
          toast(msg, { tone: "error" });
          throw new Error(msg);
        }
      }),
    [call, moodNow, moodTarget, patchMood, serialMood, store, toast]
  );

  const saveScreen = useCallback<CareActions["saveScreen"]>(
    async (d, opts) => {
      // The server scores it again; these are only the answers.
      const data = { phq9: d.phq9, gad7: d.gad7, difficulty: d.difficulty ?? null, item9_ever: d.item9_ever };
      if (opts?.id == null) return (await createMood("screen", data)).entry;
      // Once item 9 was above "Not at all" it stays set, even folded into one still waiting on this phone.
      const prev = moodNow(opts.id, moodTarget(opts.id));
      if (prev?.kind === "screen" && prev.data.item9_ever) data.item9_ever = true;
      return changeMood(opts.id, { data }, (m) => (m.kind === "screen" ? ({ ...m, data: scoreScreen({ ...data, item9_ever: data.item9_ever || m.data.item9_ever }) } as MoodEntry) : m));
    },
    [changeMood, createMood, moodNow, moodTarget]
  );

  const dismissSuggestion = useCallback<CareActions["dismissSuggestion"]>(
    async (kind) => {
      const c = careRef.current;
      if (!c) return;
      await patchPerson({ settings: { acks: { [suggestAckKey(kind, c.settings)]: clock().toISOString() } } });
    },
    [clock, patchPerson]
  );

  const moveFromMaple = useCallback<CareActions["moveFromMaple"]>(
    async (entryId, planId) => {
      try {
        const res = await call<{ entry: CareEntry; maple_entry_id: number }>("/api/maple/care/move", {
          method: "POST",
          body: JSON.stringify({ entry_id: entryId, ...(planId != null ? { med_id: planId } : {}) }),
        });
        const name = careRef.current?.person.self ? "your" : `${careRef.current?.person.name ?? "her"}'s`;
        toast(`Moved to ${name} medicines`, {
          undo: () =>
            void call("/api/maple/care/move", { method: "POST", body: JSON.stringify({ undo: { entry_id: entryId, dose_id: res.entry.id } }) })
              .then(() => toast("Undone"))
              .catch((e) => toast(e instanceof Error ? e.message : "Couldn't undo", { tone: "error" })),
        });
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't move it", { tone: "error" });
        throw fail(e, "Couldn't move it");
      }
    },
    [call, fail, toast]
  );

  const act = useMemo<CareActions>(
    () => ({
      patchPerson,
      savePlan,
      deletePlan,
      stopPlan,
      resumePlan,
      tookIt,
      logDose,
      editEntry,
      deleteEntry,
      restoreEntry,
      logTemp,
      addQuestion,
      checkin,
      updateCheckin,
      deleteMood,
      saveScreen,
      dismissSuggestion,
      moveFromMaple,
    }),
    [patchPerson, savePlan, deletePlan, stopPlan, resumePlan, tookIt, logDose, editEntry, deleteEntry, restoreEntry, logTemp, addQuestion, checkin, updateCheckin, deleteMood, saveScreen, dismissSuggestion, moveFromMaple]
  );

  const doses = useCallback(
    (planId: number, days: number) => {
      const since = now.getTime() - days * 86400_000;
      return (derived?.dosesBy.get(planId) ?? []).filter((d) => Date.parse(d.at) >= since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    },
    [derived, now]
  );

  return useMemo<UseCare | null>(() => {
    if (!care || !derived) return null;
    return {
      state: care,
      self: care.person.self,
      access: care.access,
      name: care.person.name,
      plans: derived.plans,
      finished: derived.finished,
      todayLine: derived.todayLine,
      lanternLine: derived.lanternLine,
      doses,
      ...(derived.mood ? { mood: derived.mood } : {}),
      act,
    };
  }, [act, care, derived, doses]);
}

