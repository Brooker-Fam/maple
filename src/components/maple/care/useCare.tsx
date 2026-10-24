"use client";

import { useCallback, useMemo, useRef } from "react";
import {
  careTime,
  crisisToday,
  doseNotes,
  nextUnits,
  oneOffNotes,
  oneTapDecision,
  planActive,
  planView,
  sortPlans,
  suggestFullCheckin,
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
 * logDose and tookIt, which resolve with the ask instead (nothing is ever
 * blocked, but nothing early, recent or over the limit saves silently).
 */

export type CareActions = {
  setup(member: string): Promise<void>;
  patchPerson(p: Partial<{ shared_with: string[]; settings: CareSettings }>): Promise<void>;
  savePlan(input: PlanInput, expectUpdatedAt?: string): Promise<CarePlan>;
  deletePlan(id: number): Promise<void>;
  stopPlan(id: number): Promise<void>;
  reviewPlan(id: number): Promise<void>;
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
  checkin(level: 1 | 2 | 3 | 4 | 5): Promise<MoodEntry>;
  updateCheckin(id: number, p: { tags?: MoodTag[]; note?: string }): Promise<void>;
  deleteMood(id: number): Promise<void>;
  saveScreen(d: MoodDataByKind["screen"]): Promise<MoodEntry>;
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
  /** The first Show on Today plan (non-private for others and the Lantern). */
  todayLine: { view: PlanView; more: number } | null;
  lanternLine: string | null;
  doses(planId: number, days: number): CareEntry[];
  /** Hers only. */
  mood?: { checkins: MoodEntry[]; latestScreen: MoodEntry | null; crisisToday: boolean; suggestion: "day14" | "visit" | null };
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
    // Her own Today may show an Only me plan she put there; nobody else's, and never the Lantern.
    const onToday = plans.filter((v) => v.plan.show_on_today && (self || !v.plan.private));
    const lantern = plans.find((v) => v.plan.show_on_today && !v.plan.private);
    const moodRows = care.mood;
    const latestScreen = moodRows?.find((m) => m.kind === "screen") ?? null;
    const mood = moodRows
      ? {
          checkins: moodRows.filter((m) => m.kind === "checkin").sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
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
      lanternLine: lantern?.line ?? null,
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
      const text = doseText(plan, entry);
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
      toast(urgent ? `${text}. ${noteLine(urgent)}` : text, {
        tone: urgent ? "info" : "ok",
        icon: "pill",
        actions: entry.id > 0 ? chips : undefined,
        undo: () => void deleteEntry(entry.id).catch(() => {}),
      });
    },
    [deleteEntry, doseText, editEntry, toast, tz]
  );

  const logDose = useCallback<CareActions["logDose"]>(
    async (i) => {
      const c = careRef.current;
      if (!c) throw new Error("Not shared with you");
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

  const reviewPlan = useCallback<CareActions["reviewPlan"]>(
    async (id) => {
      await planPatch(id, { reviewed: true });
    },
    [planPatch]
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

  const setup = useCallback<CareActions["setup"]>(
    async (member) => {
      try {
        await call("/api/maple/care/person", { method: "POST", body: JSON.stringify({ member }) });
      } catch (e) {
        throw fail(e, "Couldn't set that up");
      }
    },
    [call, fail]
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

  const checkin = useCallback<CareActions["checkin"]>(
    async (level) => {
      try {
        const { entry } = await call<{ entry: MoodEntry }>("/api/maple/care/mood", {
          method: "POST",
          body: JSON.stringify({ kind: "checkin", at: clock().toISOString(), data: { level }, client_id: newClientId() }),
        });
        patchMood((m) => [entry, ...m.filter((x) => x.id !== entry.id)]);
        toast(CHECKIN_SAVED);
        return entry;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
        throw fail(e, "Couldn't save that");
      }
    },
    [call, clock, fail, patchMood, toast]
  );

  const updateCheckin = useCallback<CareActions["updateCheckin"]>(
    async (id, p) => {
      const { entry } = await call<{ entry: MoodEntry }>(`/api/maple/care/mood?id=${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...(p.tags ? { data: { tags: p.tags } } : {}), ...(p.note !== undefined ? { note: p.note } : {}) }),
      });
      patchMood((m) => m.map((x) => (x.id === id ? entry : x)));
    },
    [call, patchMood]
  );

  const deleteMood = useCallback<CareActions["deleteMood"]>(
    async (id) => {
      await call(`/api/maple/care/mood?id=${id}`, { method: "DELETE" });
      patchMood((m) => m.filter((x) => x.id !== id));
      toast("Deleted");
    },
    [call, patchMood, toast]
  );

  const saveScreen = useCallback<CareActions["saveScreen"]>(
    async (d) => {
      const { entry } = await call<{ entry: MoodEntry }>("/api/maple/care/mood", {
        method: "POST",
        body: JSON.stringify({ kind: "screen", at: clock().toISOString(), data: d, client_id: newClientId() }),
      });
      patchMood((m) => [entry, ...m.filter((x) => x.kind !== "screen")]);
      return entry;
    },
    [call, clock, patchMood]
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
      setup,
      patchPerson,
      savePlan,
      deletePlan,
      stopPlan,
      reviewPlan,
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
      moveFromMaple,
    }),
    [setup, patchPerson, savePlan, deletePlan, stopPlan, reviewPlan, tookIt, logDose, editEntry, deleteEntry, restoreEntry, logTemp, addQuestion, checkin, updateCheckin, deleteMood, saveScreen, moveFromMaple]
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

/**
 * Before mom's area exists, whether this reader may set it up: "anyone" (an
 * owner) or "self" (a member, for herself); null once it exists or for
 * anyone else. For the pre-setup tile and Family row.
 */
export function useCareSetup(): "anyone" | "self" | null {
  const { state } = useMaple();
  return state?.care_setup ?? null;
}
