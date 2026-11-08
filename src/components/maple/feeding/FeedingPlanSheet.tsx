"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { amountText, checkInText, clockWords, everyText, feedById, feedingPlanOf, PLAN_LIMITS, stepText, type FeedingPlan, type PlanFeed } from "@/lib/maple/feeding-plan";
import { dayKey, DEFAULT_TZ } from "@/lib/maple/time";
import type { Baby } from "@/lib/maple/types";
import { feedTargetOf, type FeedTarget } from "@/lib/maple/units";
import { AskChatButton } from "../chat/AskChat";
import { useAskWho, useBabyWords } from "../familyWords";
import { Icon } from "../icons";
import { ContextNote, useNumberChecks } from "../sheets/parts";
import { Button, cx, Sheet, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import { PlanForm, type PlanMark } from "./FeedingPlanForm";
import { draftFromShape, draftOf, draftProblem, inputOf, PLAN_SHAPES, problemPlace, samePlan, sameTarget, wakeText, type PlanDraft, type PlanShape } from "./planDraft";

/**
 * The feeding plan's sheet: the family's plan from their care team
 * (settings.feeding_plan) laid out for a tired reader, and the form that adds
 * or changes it. Opened with useFeedingPlanNav().openPlan() from Today's Next
 * feed card, Settings and More; `edit` opens straight on the form.
 *
 * View: who it's from and the next check-in, the target per feed, how often
 * by day and the order the feeds take turns in, the night, each feed's steps
 * numbered in the plan's own words (stepText), and notes. Owners and members
 * can edit it, change it in the chat or remove it; viewers only read it, and
 * photos-only guests never see it. With no plan: what it does, Add a plan, or
 * send a photo of the plan sheet to the chat (read back there, saved on a yes).
 *
 * Edit: a new plan starts from a shape (the kinds of step, no numbers). Save
 * checks the plan as the server will (draftProblem), then sends PATCH
 * /api/maple/baby { settings: { feeding_plan: { ...plan, base_rev },
 * feed_target_ml } }, amounts in ml, each only when it changed. A plan saved
 * on another phone meanwhile comes back as a 409 with the latest: load it, or
 * save this one over it. Unsaved changes ask before the sheet closes.
 */

const CHANGE_PROMPT = "I'd like to change our feeding plan: ";
const PHOTO_PROMPT = "Please add our feeding plan from this photo, and read it back to me before saving it.";

type Edit = {
  /** The plan this edit began from (null: a new plan), and the target then. */
  base: FeedingPlan | null;
  baseTarget: FeedTarget | null;
  /** The draft as it opened (dirty is anything since), null while a new plan's shape is still to pick. */
  initial: PlanDraft | null;
  draft: PlanDraft | null;
};
/** A save turned away because the plan changed on another phone: the plan as it is now (null: removed). */
type Conflict = { latest: FeedingPlan | null };

const errorText = (e: unknown, fallback: string) => {
  if (!(e instanceof ApiError)) return `${fallback} Check the connection and try again.`;
  // The route's own size cap: the whole of the family's settings.
  if (/settings too large/i.test(e.message)) return "The plan is too long to save. Shorter notes or fewer steps will fit.";
  return e.message || fallback;
};

export default function FeedingPlanSheet({ open, edit: startEditing = false, onClose }: { open: boolean; edit?: boolean; onClose: () => void }) {
  const { state, readOnly, api, refresh, toast, units, now } = useMaple();
  const canWrite = !!state && !readOnly;
  // The settings a save or removal answered with, until the state's next read (its rev) brings them.
  const [answered, setAnswered] = useState<{ rev: string; settings: Record<string, unknown> } | null>(null);
  const settings = answered && state && answered.rev === state.rev ? answered.settings : state?.baby.settings;
  const plan = useMemo(() => feedingPlanOf(settings), [settings]);
  const target = useMemo(() => feedTargetOf(settings), [settings]);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const unit = units === "metric" ? "ml" : "oz";

  const begin = (from: FeedingPlan | null, t: FeedTarget | null): Edit => {
    const d = from ? draftOf(from, t, unit) : null;
    return { base: from, baseTarget: t, initial: d, draft: d };
  };
  const [editing, setEditing] = useState<Edit | null>(() => (startEditing && canWrite ? begin(plan, target) : null));
  const [problem, setProblem] = useState<{ message: string; mark: PlanMark | null } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"remove" | "discard" | null>(null);
  const checks = useNumberChecks();
  // A marker in the sheet's scrolling body (hidden, so it takes no room): its parent is what scrolls.
  const top = useRef<HTMLSpanElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const draft = editing?.draft ?? null;
  const mode = !editing ? "view" : draft ? "form" : "shapes";
  const dirty = !!draft && !!editing?.initial && (!samePlan(draft, editing.initial) || !sameTarget(inputOf(draft).target, inputOf(editing.initial).target));

  // A new screen of the sheet starts at its top; a refusal comes into view where it's marked (or at the top).
  useEffect(() => {
    top.current?.parentElement?.scrollTo({ top: 0 });
  }, [mode]);
  useEffect(() => {
    if (!problem && !conflict) return;
    // A step's problem: the step (short enough to show whole); a feed's: its words, under the feed's name.
    const mark = problem?.mark;
    const marked = mark ? document.querySelector(mark.step ? `[data-plan-step="${mark.step}"]` : `[data-plan-feed="${mark.feed}"] [data-plan-problem]`) : null;
    (marked ?? alertRef.current)?.scrollIntoView({ block: "center" });
  }, [problem, conflict]);

  if (!state || state.me.role === "photos") return null;

  const change = (fn: (d: PlanDraft) => PlanDraft) => {
    setEditing((e) => (e?.draft ? { ...e, draft: fn(e.draft) } : e));
    setProblem(null);
  };
  const leave = () => {
    setEditing(null);
    setProblem(null);
    setConflict(null);
  };
  const startEdit = () => {
    setNotice(null);
    setEditing(begin(plan, target));
  };
  const pickShape = (shape: PlanShape) => {
    const d = draftFromShape(shape, target, unit);
    setEditing((e) => ({ base: e?.base ?? null, baseTarget: e?.baseTarget ?? target, initial: d, draft: d }));
  };

  const save = async (over?: Conflict) => {
    if (!editing?.draft || busy || checks.invalid) return;
    const d = editing.draft;
    const base = over ? over.latest : editing.base;
    const { plan: input, target: t } = inputOf(d);
    // Only what changed goes: an untouched plan isn't saved again, nor an untouched target (Settings may have one open).
    const planChanged = !!over || !editing.base || !editing.initial || !samePlan(d, editing.initial);
    const targetChanged = !sameTarget(t, editing.baseTarget);
    if (!planChanged && !targetChanged) return leave();
    // Checked here first, as the server will: nothing is sent while it would be refused.
    const local = draftProblem(d, base, now(), planChanged);
    if (local) {
      const at = problemPlace(local, d);
      setProblem({ message: local, mark: at ? { ...at, message: local } : null });
      return;
    }
    const body = {
      settings: {
        ...(planChanged ? { feeding_plan: { ...input, ...(base ? { base_rev: base.rev } : {}) } } : {}),
        ...(targetChanged ? { feed_target_ml: t } : {}),
      },
    };
    const rev = state.rev;
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ baby?: Baby }>("/api/maple/baby", { method: "PATCH", body: JSON.stringify(body) });
      if (r?.baby?.settings) setAnswered({ rev, settings: r.baby.settings });
      setConflict(null);
      setEditing(null);
      toast("Feeding plan saved");
      void refresh();
    } catch (e) {
      const reason = e instanceof ApiError ? (e.body as { reason?: string; feeding_plan?: unknown } | null) : null;
      if (e instanceof ApiError && e.status === 409 && reason?.reason === "plan_changed") {
        setConflict({ latest: feedingPlanOf({ feeding_plan: reason.feeding_plan }) });
        void refresh();
      } else {
        const message = errorText(e, "Couldn't save the plan.");
        const at = problemPlace(message, d);
        setProblem({ message, mark: at ? { ...at, message } : null });
      }
    } finally {
      setBusy(false);
    }
  };

  const loadLatest = () => {
    const latest = conflict?.latest ?? null;
    setConflict(null);
    setProblem(null);
    setEditing(begin(latest, target));
  };

  const remove = async () => {
    if (!plan || busy) return;
    const rev = state.rev;
    setBusy(true);
    try {
      const r = await api<{ baby?: Baby }>("/api/maple/baby", { method: "PATCH", body: JSON.stringify({ settings: { feeding_plan: null, feeding_plan_base_rev: plan.rev } }) });
      if (r?.baby?.settings) setAnswered({ rev, settings: r.baby.settings });
      setConfirm(null);
      setNotice(null);
      toast("Feeding plan removed");
      void refresh();
    } catch (e) {
      setConfirm(null);
      const reason = e instanceof ApiError ? (e.body as { reason?: string; feeding_plan?: unknown } | null) : null;
      if (e instanceof ApiError && e.status === 409 && reason?.reason === "plan_changed") {
        // Changed on another phone first: this shows theirs, and nothing was removed.
        setAnswered({ rev, settings: { ...state.baby.settings, feeding_plan: reason.feeding_plan ?? null } });
        setNotice(reason.feeding_plan ? "The plan was changed on another phone just now, so it wasn't removed. This is the plan now." : "The plan was already removed on another phone.");
        void refresh();
      } else toast(errorText(e, "Couldn't remove the plan."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => (dirty ? setConfirm("discard") : leave());

  const title = mode === "view" ? "Feeding plan" : editing?.base ? "Edit the feeding plan" : "New feeding plan";
  const today = dayKey(now(), tz);
  const subtitle =
    mode === "view" && plan
      ? [plan.from ? `From ${plan.from}` : "From your care team", plan.check_in ? `${plan.check_in < today ? "Check-in was" : "Check-in"} ${checkInText(plan.check_in)}` : null].filter(Boolean).join(" · ")
      : mode === "shapes"
        ? "Start from the closest shape"
        : undefined;

  const footer =
    mode === "form" ? (
      <div>
        {checks.invalid && <p className={cx(tone.muted, "mb-2 text-center text-xs")}>Check the number marked in red.</p>}
        <div className="flex items-center gap-3">
          <Button variant="soft" size="lg" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button size="lg" className="flex-1" disabled={busy || checks.invalid} onClick={() => void save()}>
            {busy ? "Saving…" : "Save the plan"}
          </Button>
        </div>
      </div>
    ) : undefined;

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        dirty={dirty}
        title={title}
        subtitle={subtitle}
        footer={footer}
        actions={
          mode === "shapes" ? (
            <Button variant="ghost" size="sm" onClick={leave}>
              Back
            </Button>
          ) : undefined
        }
      >
        <span ref={top} hidden />
        {mode === "view" && (
          <>
            {notice && (
              <p role="status" className={cx(tone.inset, "px-4 py-3 text-[15px] leading-relaxed text-mp-ink")}>
                {notice}
              </p>
            )}
            {plan ? (
              <PlanView plan={plan} target={target} canWrite={canWrite} onEdit={startEdit} onRemove={() => setConfirm("remove")} onClose={onClose} />
            ) : (
              <NoPlan canWrite={canWrite} onAdd={startEdit} onClose={onClose} />
            )}
          </>
        )}
        {mode === "shapes" && <ShapePicker onPick={pickShape} />}
        {mode === "form" && draft && (
          <>
            {(problem || conflict) && (
              <div ref={alertRef} className="scroll-mt-4">
                {conflict ? (
                  <div role="alert" className={cx(tone.card, "space-y-3 px-4 py-3.5")}>
                    <p className="text-[15px] leading-relaxed text-mp-ink">
                      {conflict.latest
                        ? "The feeding plan was changed on another phone just now, so this wasn't saved."
                        : "The feeding plan was removed on another phone just now, so this wasn't saved."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {conflict.latest && (
                        <Button variant="soft" disabled={busy} onClick={loadLatest}>
                          Load the latest
                        </Button>
                      )}
                      <Button variant="ghost" disabled={busy} onClick={() => void save(conflict)}>
                        {conflict.latest ? "Save mine instead" : "Save mine as a new plan"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p role="alert" data-plan-problem className={cx(tone.inset, "px-4 py-3 text-[15px] leading-relaxed font-semibold text-mp-danger")}>
                    {problem!.message}
                  </p>
                )}
              </div>
            )}
            <PlanForm
              draft={draft}
              initial={editing?.initial ?? null}
              change={change}
              watch={checks.watch}
              invalid={checks.invalid}
              mark={problem?.mark ?? null}
              onRemoved={(what, undo) => toast(what, { undo, undoLabel: "Put it back" })}
            />
          </>
        )}
      </Sheet>
      <ConfirmSheet
        open={open && confirm === "remove"}
        title="Remove the feeding plan?"
        body="Today stops showing the next feed from it. Feeds already logged stay as they are."
        confirm="Remove plan"
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmSheet
        open={open && confirm === "discard"}
        title="Discard unsaved changes?"
        body="Your changes to the plan have not been saved."
        cancel="Keep editing"
        confirm="Discard changes"
        onConfirm={() => {
          setConfirm(null);
          leave();
        }}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

// ── the plan, to read ──────────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The feeds in the order a family meets them: the day's turns, then the night's, then any other. */
function feedsInOrder(plan: FeedingPlan): { feed: PlanFeed; badge: string | null }[] {
  const night = plan.night?.feed ?? null;
  const turns = plan.order.map((id) => feedById(plan, id)).filter((f): f is PlanFeed => !!f);
  const rest = plan.feeds.filter((f) => !turns.includes(f));
  const nightFeed = rest.find((f) => f.id === night);
  const others = rest.filter((f) => f !== nightFeed);
  const one = plan.feeds.length === 1;
  return [
    ...turns.map((feed, i) => ({ feed, badge: one ? null : turns.length > 1 ? `Turn ${i + 1}${feed.id === night ? " · night" : ""}` : feed.id === night ? "By day · night" : "By day" })),
    ...(nightFeed ? [{ feed: nightFeed, badge: "At night" }] : []),
    ...others.map((feed) => ({ feed, badge: "Not in the turns" })),
  ];
}

function PlanView({ plan, target, canWrite, onEdit, onRemove, onClose }: { plan: FeedingPlan; target: FeedTarget | null; canWrite: boolean; onEdit: () => void; onRemove: () => void; onClose: () => void }) {
  const w = useBabyWords();
  const turns = plan.order.map((id) => feedById(plan, id)).filter((f): f is PlanFeed => !!f);
  const night = plan.night;
  const nightFeed = night ? feedById(plan, night.feed) : null;
  // When to wake her, in hours: the window's end (with no time between feeds, there's no time to wake her at).
  const nightEvery = night?.every ?? plan.day.every;
  const nightHow = night
    ? [
        night.every ? cap(everyText(night.every)) : plan.day.every ? `${cap(everyText(plan.day.every))}, as by day` : "No set time between feeds",
        night.wake && nightEvery ? wakeText(nightEvery, w) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const dayHow = plan.day.every ? (plan.day.wake ? cap(wakeText(plan.day.every, w, { from: true })) : "From the start of one feed to the next") : undefined;
  return (
    <div className="space-y-5">
      <dl className={cx(tone.card, tone.divide, "overflow-hidden")}>
        {target && (
          <Fact label="Target per feed">
            <span className="font-semibold">{amountText(target, plan.unit)}</span>
          </Fact>
        )}
        <Fact label={night ? "By day" : "How often"} sub={dayHow}>
          {plan.day.every ? cap(everyText(plan.day.every)) : "No set time between feeds"}
        </Fact>
        {turns.length > 1 && (
          <Fact label="Taking turns by day">
            <ol className="mt-0.5 space-y-0.5">
              {turns.map((f, i) => (
                <li key={f.id} className="flex gap-2 [overflow-wrap:anywhere]">
                  <span className="w-4 shrink-0 text-mp-ink-2 tabular-nums">{i + 1}</span>
                  <span className="min-w-0">{f.name}</span>
                </li>
              ))}
            </ol>
          </Fact>
        )}
        {night && (
          <Fact label="At night" sub={nightHow}>
            <span className="tabular-nums">
              {clockWords(night.from)} to {clockWords(night.to)}
            </span>
            <span className="text-mp-ink-2"> · </span>
            <span className="[overflow-wrap:anywhere]">{nightFeed ? nightFeed.name : "same turns as by day"}</span>
          </Fact>
        )}
      </dl>

      <section aria-label="The feeds" className="space-y-3">
        {feedsInOrder(plan).map(({ feed, badge }) => (
          <FeedCard key={feed.id} feed={feed} badge={badge} plan={plan} target={target} />
        ))}
      </section>

      {plan.notes && (
        <section aria-label="Notes" className={cx(tone.card, "px-4 py-3.5")}>
          <h3 className={tone.label}>Notes</h3>
          <p className="mt-1 text-[15px] leading-relaxed text-mp-ink [overflow-wrap:anywhere]">{plan.notes}</p>
        </section>
      )}

      {canWrite && (
        <div className="space-y-1">
          <Button variant="soft" className="w-full" onClick={onEdit}>
            <Icon name="pencil" size={16} /> Edit the plan
          </Button>
          <div className="-mx-3 flex flex-wrap items-center justify-between gap-x-1">
            <AskChatButton prompt={CHANGE_PROMPT} label="Feeding plan" onOpened={onClose}>
              Change it in the chat
            </AskChatButton>
            <button type="button" onClick={onRemove} className="mp-control min-h-[44px] rounded-[10px] px-3 text-sm font-semibold text-mp-danger transition hover:bg-mp-danger/10 active:scale-[0.98]">
              Remove plan
            </button>
          </div>
        </div>
      )}
      <ContextNote>As entered from your care team&apos;s plan. If something in it doesn&apos;t seem right, check with them.</ContextNote>
    </div>
  );
}

function Fact({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <dt className={tone.label}>{label}</dt>
      <dd className="mt-0.5 text-[16px] leading-snug text-mp-ink">{children}</dd>
      {sub && <dd className={cx(tone.muted, "mt-0.5 text-[14px] leading-snug")}>{sub}</dd>}
    </div>
  );
}

/** One feed: its name, where it falls, and its steps numbered (a note is a plain line). */
function FeedCard({ feed, badge, plan, target }: { feed: PlanFeed; badge: string | null; plan: FeedingPlan; target: FeedTarget | null }) {
  let n = 0;
  let nursed = false;
  return (
    <article aria-label={feed.name} className={cx(tone.card, "px-4 pt-3 pb-3.5")}>
      <div className="flex items-start justify-between gap-3">
        <h3 className={cx(tone.heading, "min-w-0 text-[17px] leading-snug [overflow-wrap:anywhere]")}>{feed.name}</h3>
        {badge && <span className="mt-0.5 shrink-0 rounded-full bg-mp-sunken px-2.5 py-0.5 text-[12px] font-medium text-mp-ink-2">{badge}</span>}
      </div>
      <ol className="mt-2.5 space-y-2.5" aria-label={`${feed.name}: steps`}>
        {feed.steps.map((s, i) => {
          const words = stepText(s, plan, target, { afterNurse: nursed });
          if (s.do === "nurse") nursed = true;
          if (s.do === "note") {
            return (
              <li key={i} className="pl-[34px] text-[14px] leading-snug text-mp-ink-2 [overflow-wrap:anywhere]">
                {words}
              </li>
            );
          }
          n++;
          return (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden className="mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-[12px] font-semibold text-mp-ink-2 tabular-nums">
                {n}
              </span>
              <p className="min-w-0 text-[15px] leading-snug text-mp-ink [overflow-wrap:anywhere]">
                <span className="sr-only">Step {n}: </span>
                {words}
              </p>
            </li>
          );
        })}
      </ol>
    </article>
  );
}

function NoPlan({ canWrite, onAdd, onClose }: { canWrite: boolean; onAdd: () => void; onClose: () => void }) {
  const ask = useAskWho();
  return (
    <div className="space-y-4">
      <div className={cx(tone.inset, "space-y-1.5 px-4 py-3.5")}>
        <p className={cx(tone.heading, "text-[16px]")}>A plan from your care team</p>
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
          If they gave you a feeding plan, keep it here. Today then shows which feed is next, when it&apos;s due and its steps, one tap each.
        </p>
      </div>
      {canWrite ? (
        <div className="space-y-1">
          <Button size="lg" className="w-full" onClick={onAdd}>
            Add a plan
          </Button>
          <div className="-mx-3">
            <AskChatButton prompt={PHOTO_PROMPT} label="Feeding plan" onOpened={onClose}>
              Send a photo of your plan to the chat
            </AskChatButton>
          </div>
        </div>
      ) : (
        <p className={cx(tone.muted, "px-1 text-[14px]")}>No feeding plan yet. Ask {ask} to add one.</p>
      )}
    </div>
  );
}

function ShapePicker({ onPick }: { onPick: (shape: PlanShape) => void }) {
  return (
    <div className="space-y-3">
      <p className={cx(tone.muted, "px-1 text-[15px] leading-relaxed")}>Pick the one closest to your plan. Next you&apos;ll copy in its minutes and amounts.</p>
      <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
        {PLAN_SHAPES.map((s) => (
          <button key={s.id} type="button" onClick={() => onPick(s)} className={cx(tone.row, "min-h-[64px] py-3")}>
            <span className="min-w-0 flex-1">
              <span className="block text-[16px] font-medium text-mp-ink">{s.title}</span>
              <span className={cx(tone.muted, "block text-[13px] leading-snug")}>{s.sub}</span>
            </span>
            <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
          </button>
        ))}
      </div>
      <p className={cx(tone.faint, "px-1 text-[13px] leading-snug")}>
        Up to {PLAN_LIMITS.feeds} feeds of {PLAN_LIMITS.steps} steps each. Every step can be changed after.
      </p>
    </div>
  );
}

/** A plain yes-or-no over the sheet. */
function ConfirmSheet({ open, title, body, cancel = "Cancel", confirm, busy, onConfirm, onClose }: { open: boolean; title: string; body: string; cancel?: string; confirm: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      calm
      footer={
        <div className="flex gap-3">
          <Button variant="soft" size="lg" className="flex-1" onClick={onClose}>
            {cancel}
          </Button>
          <Button variant="danger" size="lg" className="flex-1" disabled={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      }
    >
      <p className="text-mp-ink-2">{body}</p>
    </Sheet>
  );
}
