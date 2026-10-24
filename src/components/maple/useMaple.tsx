"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVisiblePoll } from "@/lib/use-visible-poll";
import {
  addPart,
  feedCtx,
  moveEdge,
  normalizeSegments,
  pause as pauseFeed,
  setSide,
  startBreast,
  stopBreast,
  summarize as summarizeSegments,
  switchTo,
  undoLastTap,
  type FeedCtx,
} from "@/lib/maple/feed";
import { memberLabel as labelOf, summarize, memberName as nameOf, type Summary } from "@/lib/maple/insights";
import { formatTime, localParts } from "@/lib/maple/time";
import type {
  CareEntry,
  CareEntryInput,
  CareState,
  CreateEntryInput,
  DoseEntry,
  Entry,
  FeedData,
  FeedEdit,
  MapleState,
  MapleStateUnchanged,
  Member,
  TimerInput,
  TimerResponse,
  UnitSystem,
  UpdateEntryInput,
} from "@/lib/maple/types";
import type { IconName } from "./icons";

/**
 * Client state for Maple's Log: one provider at the top of the app holds the
 * server snapshot, polls for the other parent's changes, and exposes
 * optimistic actions (log, edit, delete, timers) with undo toasts.
 *
 * New entries carry a client_id. If the network drops (hospital Wi-Fi, a dead
 * zone on the farm) the entry stays on screen, waits in a localStorage outbox
 * and syncs when the connection is back; the server dedupes on client_id, so
 * a retry can never double-log.
 */

export type AuthInfo = {
  signedIn: boolean;
  google: boolean;
  password: boolean;
  reason?: string | null;
};

export type ToastAction = {
  label: string;
  onClick: () => void;
  color?: string;
  ariaLabel?: string;
  /** A second line under the label: the time a chip produces ("5 min earlier" over "4:00"). */
  sub?: string;
};

export type Toast = {
  id: number;
  text: string;
  tone: "ok" | "error" | "info";
  undo?: () => void;
  /** The trailing button's label (default "Undo"): "Back to 4:25", "Put it back". */
  undoLabel?: string;
  /** Extra inline buttons (e.g. stool-color swatches after "Poop"). */
  actions?: ToastAction[];
  /** Milliseconds; default 3.5s, or longer with undo/actions (8s by day, 12s at night). */
  duration?: number;
  /** One toast per group: a new timer toast replaces the one showing. */
  group?: "timer";
  /** Close early once this entry is newer than the version the toast was built from (someone else changed it). */
  watch?: { entryId: number; updatedAt: string };
  /** The mark in place of the check: a saved diaper wears its drop or pile (toastIcon). */
  icon?: IconName;
};

/** A diaper's toast says what was saved by its mark: the pile if it had poop, else the drop (a dry one keeps the check). */
const toastIcon = (e: Entry): IconName | undefined => (e.kind === "diaper" ? (e.data.poop ? "poop" : e.data.pee ? "droplet" : undefined) : undefined);

/**
 * Why a timer call didn't happen, for callers that report it themselves
 * (the Fix times sheet shows it inline instead of a toast). `who` names the
 * person behind a 409 (null: this viewer, the admin login, or unknown).
 */
export type TimerFailure = {
  kind: "changed" | "stopped" | "gone" | "bad" | "offline" | "pending" | "error";
  message: string;
  who: string | null;
  entry?: Entry;
  /** FeedEditError code on a 400 ("before_break", …). */
  code?: string;
};

export type TimerCallOptions = {
  /** Skip the "just changed this feed" toast on a 409 (the caller says it its own way). */
  silent409?: boolean;
  /** Report every failure here instead of a toast. */
  onError?: (f: TimerFailure) => void;
  /** Buttons for the failure toast (a stale Resume after the other phone's Done: "Continue that feed on Right"). */
  failActions?: (f: TimerFailure) => ToastAction[] | undefined;
  /** A better line for the failure toast than the generic one ("Brittany already put her back on the Left at 5:46"); undefined keeps it. */
  failText?: (f: TimerFailure) => string | undefined;
};

/**
 * A timer call. discard takes `expect_updated_at` (the start toast's Undo):
 * if someone changed the timer since, it answers 409 "changed" and nothing
 * is thrown away.
 */
export type TimerCallInput = TimerInput & { expect_updated_at?: string };

type Status = "loading" | "signedOut" | "ready" | "error";

export type MapleContextValue = {
  status: Status;
  error: string | null;
  auth: AuthInfo | null;
  state: MapleState | null;
  summary: Summary | null;
  /** Server-corrected "now". */
  now: () => Date;
  /** 8pm–7am in the baby's timezone. */
  isNight: () => boolean;
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
  refresh: () => Promise<void>;
  /** Entries saved on this phone, waiting for a connection. */
  pending: number;
  online: boolean;
  /**
   * When this member was last here before this visit (from the first poll),
   * for the "While you slept" card.
   */
  seenAt: string | null;
  /** Log an entry. Resolves to the saved entry (or the pending optimistic one when offline; null on failure). */
  log: (
    input: CreateEntryInput,
    opts?: {
      toast?: string;
      silent?: boolean;
      actions?: (entry: Entry) => ToastAction[];
    }
  ) => Promise<Entry | null>;
  update: (id: number, patch: UpdateEntryInput, opts?: { toast?: string }) => Promise<Entry | null>;
  remove: (id: number, opts?: { toast?: string }) => Promise<void>;
  /** `quiet`: no "Restored" toast (an Undo that says its own "Undone"). */
  restore: (id: number, opts?: { quiet?: boolean }) => Promise<Entry | null>;
  /**
   * A timer action with the server's whole answer (noop, merged, before, …),
   * or null when it didn't happen. Calls for one entry go one at a time, in
   * tap order; if one fails, the taps queued behind it are dropped.
   */
  timerCall: (input: TimerCallInput, opts?: TimerCallOptions) => Promise<TimerResponse | null>;
  timer: (input: TimerInput) => Promise<Entry | null>;
  /**
   * True while a timer call for this entry is queued or waiting for the
   * server (Fix times holds its chips meanwhile, as it does for a timer
   * that's still starting, so this phone's own tap never reads as someone
   * else's change).
   */
  timerBusy: (id: number) => boolean;
  /** Raw JSON fetch against /api/maple; throws ApiError (with .status, .body). */
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  toasts: Toast[];
  /** Show a toast; returns its id (for dismissToast). */
  toast: (text: string, opts?: Partial<Omit<Toast, "id" | "text">>) => number;
  dismissToast: (id: number) => void;
  /** Close the timer toast, if one is up (a dock tap, Fix times opening). */
  dismissTimerToast: () => void;
  /**
   * While the Lantern or Fix times covers the screen, timer toasts wait (only
   * the latest); when the last hold ends it shows if the tap was under 2
   * minutes ago, its entry hasn't changed since, and no newer toast came up
   * (the sheet's own save, even one answering just after it closed). Holds
   * count, so each `true` needs its own `false` (or use useHoldTimerToasts).
   */
  holdTimerToasts: (on: boolean) => void;
  memberName: (id: string | null | undefined) => string;
  /** A name worth printing for a member id, or null for the viewer, unknown ids and an admin login acting as nobody. */
  memberLabel: (id: string | null | undefined) => string | null;
  /**
   * Who discarded entry `id` (memberLabel of the last edit, so null for the
   * viewer, the admin login or an unknown), or undefined if it isn't among
   * the recently discarded (still there, or the lookup failed). For "Brittany
   * discarded this feed" when a poll is what noticed it was gone.
   */
  whoDiscarded: (id: number) => Promise<string | null | undefined>;
  member: (id: string | null | undefined) => Member | null;
  /** True for read-only viewers (hide logging controls). */
  readOnly: boolean;
  /**
   * Mom's area in the shared state (useCare in care/useCare.tsx is built on
   * these): change state.care at once (an optimistic dose, a plan edit),
   * hold polls while a care write is out, and queue a dose, temperature or
   * question for when the connection is back (it shows as pending meanwhile).
   */
  care: {
    patch: (fn: (c: CareState) => CareState) => void;
    track: <T>(fn: () => Promise<T>) => Promise<T>;
    queue: (input: CareEntryInput, entry: CareEntry) => void;
    /** Drop a queued care item (deleted before it synced); true if it was queued. */
    unqueue: (entryId: number) => boolean;
    /** A temporary (negative) id for an optimistic care entry; never one Maple's entries use. */
    tempId: () => number;
  };
};

const MapleContext = createContext<MapleContextValue | null>(null);

export function useMaple(): MapleContextValue {
  const ctx = useContext(MapleContext);
  if (!ctx) throw new Error("useMaple must be used inside <MapleProvider>");
  return ctx;
}

/**
 * Hold timer toasts while `on` (the Lantern, the Fix times sheet): any one
 * showing closes, new ones wait, and the latest shows when the hold ends if
 * it's still true. A save from the sheet leaves its own toast, which
 * replaces whatever was waiting.
 */
export function useHoldTimerToasts(on: boolean) {
  const { holdTimerToasts } = useMaple();
  useEffect(() => {
    if (!on) return;
    holdTimerToasts(true);
    return () => holdTimerToasts(false);
  }, [on, holdTimerToasts]);
}

/** Re-render on an interval (for live timers and "5m ago" labels). */
export function useNow(intervalMs = 1000): Date {
  const { now } = useMaple();
  const [t, setT] = useState(() => now());
  useEffect(() => {
    const id = setInterval(() => setT(now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, now]);
  return t;
}

const UNITS_KEY = "maple-units";
const OUTBOX_KEY = "maple-outbox-v1";
const POLL_MS = 10_000;
/** Back after this long → refresh "While you slept" from the server. */
const AWAY_MS = 3 * 3600_000;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

/**
 * An edit or delete of an entry someone discarded meanwhile (PATCH / DELETE
 * /api/maple/entries answer 404 { reason: "discarded", deleted_by }): the
 * toast line, naming who (memberLabel; neutral when that's this viewer, the
 * admin login or unknown), instead of a raw "Entry 165 not found". null for
 * any other error. `saving` is what the edit carried: "note" or "change".
 */
function discardedLine(err: unknown, kind: string | undefined, label: (id: string | null | undefined) => string | null, saving?: "note" | "change"): string | null {
  if (!(err instanceof ApiError) || err.status !== 404) return null;
  const b = err.body as { reason?: string; deleted_by?: string | null } | null;
  if (b?.reason !== "discarded") return null;
  const who = label(b.deleted_by);
  const [thing, done] = kind === "feed" ? ["feed", "discarded"] : ["entry", "deleted"];
  if (saving) {
    const lost = `so your ${saving} wasn't saved.`;
    return who ? `${who} ${done} this ${thing}, ${lost}` : `This ${thing} was ${done} on another device or through Claude, ${lost}`;
  }
  return who ? `${who} already ${done} this ${thing}.` : `This ${thing} was already ${done} on another device or through Claude.`;
}

/** Network down or server hiccup: worth keeping and retrying, unlike a 4xx. */
const isTransient = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path.startsWith("/") ? path : `/api/maple/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON (e.g. 502 page)
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

/**
 * One write waiting for a connection. `target` says where it goes: Maple's
 * entries (the default, so items saved before targets existed still post to
 * /api/maple/entries), mom's care entries, or her check-ins. The key stays
 * maple-outbox-v1.
 */
type OutboxItem =
  | { target?: "entries"; client_id: string; input: CreateEntryInput; entry: Entry; tries: number }
  | { target: "care"; client_id: string; input: CareEntryInput; entry: CareEntry; tries: number }
  | { target: "mood"; client_id: string; input: Record<string, unknown>; entry: { id: number }; tries: number };
type EntryItem = Extract<OutboxItem, { input: CreateEntryInput }>;
type CareItem = Extract<OutboxItem, { target: "care" }>;
const isEntryItem = (i: OutboxItem): i is EntryItem => !i.target || i.target === "entries";
const isCareItem = (i: OutboxItem): i is CareItem => i.target === "care";
const OUTBOX_URL = { entries: "/api/maple/entries", care: "/api/maple/care/entries", mood: "/api/maple/care/mood" } as const;

function readOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    const items = raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function writeOutbox(items: OutboxItem[]) {
  try {
    if (items.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    // storage blocked: the entry still shows until reload
  }
}

function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

let tempId = -1;

const TIMER_TOAST_HOLD_MS = 2 * 60_000;

const byStart = (es: Entry[]) => es.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

/** One entry's timer calls: the last one's outcome (true: it happened), how many are queued or out, and the early copies they showed. */
type TimerQueue = { tail: Promise<boolean>; n: number; mine: Set<Entry> };

/** Put back the parts a fix replaced (the optimistic copy of retime restore). */
function restoredFeed(e: Entry & { kind: "feed" }, d: FeedData, edit: Extract<FeedEdit, { op: "restore" }>): Entry {
  // An end on a feed that's running again finishes it there (the Undo of a Continue), as the server does.
  const active = e.active && edit.ended_at == null;
  const segments = normalizeSegments(edit.segments, { active });
  const t = summarizeSegments(segments);
  const data: FeedData = { ...d, segments, first_side: t.first_side ?? d.first_side, last_side: t.last_side ?? d.last_side };
  if (!active) Object.assign(data, { left_sec: t.left_sec, right_sec: t.right_sec });
  if (!active && edit.paused_at_stop) data.paused_at_stop = true;
  return { ...e, active, data, started_at: edit.started_at, ended_at: active ? null : edit.ended_at };
}

/**
 * What a timer action does to an entry, run through the same feed engine as
 * the server, so the card moves at the tap. null: it's gone (discard);
 * undefined: leave it for the server (an edit the engine refuses, or an
 * action with nothing to show early).
 */
function optimisticTimer(e: Entry, input: TimerInput, at: Date, now: Date, by?: string): Entry | null | undefined {
  if (input.action === "discard") return null;
  // A join swaps one feed for another: shown when the server answers (an early "gone" would flash an idle dock).
  if (input.action === "join") return undefined;
  const explicit = !!input.at;
  try {
    if (e.kind === "feed" && e.data.method === "breast" && e.data.segments?.length) {
      const d = e.data;
      const ctx: FeedCtx = feedCtx(e, now);
      switch (input.action) {
        case "switch":
        case "resume":
          // A resume of a feed this phone already shows back on (the other phone's resume came in): the server's rule, so no early switch.
          // `by`: the server's re-side rule only re-sides this person's own resume.
          return { ...e, data: switchTo(d, input.side ?? "L", at, { explicit, resume: input.action === "resume", now, by }).data };
        case "pause":
          return { ...e, data: pauseFeed(d, at, { explicit, now, by }).data };
        case "stop": {
          const s = stopBreast(d, explicit ? at : undefined, now);
          return { ...e, active: false, ended_at: s.endedAt, data: s.data };
        }
        case "adjust": {
          const m = moveEdge(d, { edge: "start", to: at }, ctx);
          return { ...e, data: m.data, started_at: m.startedAt };
        }
        case "retime": {
          const edit = input.edit;
          if (!edit) return undefined;
          if (edit.op === "move") {
            const m = moveEdge(d, { edge: edit.edge, ref: edit.ref, to: new Date(edit.to) }, ctx);
            return { ...e, data: m.data, started_at: m.startedAt, ended_at: e.active ? null : m.endedAt };
          }
          if (edit.op === "set_side") {
            const s = setSide(d, edit.ref, edit.side, ctx);
            return { ...e, data: s.data, started_at: s.startedAt };
          }
          if (edit.op === "undo_tap") return { ...e, data: undoLastTap(d, edit.expect, { active: e.active }).data };
          if (edit.op === "add_part") {
            const a = addPart(d, { side: edit.side, start: edit.start, end: edit.end }, ctx);
            return { ...e, data: a.data, started_at: a.startedAt, ended_at: a.endedAt };
          }
          return restoredFeed(e, d, edit);
        }
      }
      return undefined;
    }
  } catch {
    // A FeedEditError (or odd data): no early change; the server decides and says why.
    return undefined;
  }
  if (input.action === "stop") {
    const t = Math.max(Date.parse(e.started_at), Math.min(at.getTime(), now.getTime()));
    return { ...e, active: false, ended_at: new Date(t).toISOString() };
  }
  if (input.action === "adjust") return { ...e, started_at: at.toISOString() };
  return undefined;
}

/**
 * A poll that left before a mutation answered can come back after it with
 * the older row. Entries a mutation confirmed (`confirmed`: id → updated_at,
 * and when it was confirmed) keep this phone's copy until a poll returns that
 * version or newer; one the poll doesn't have yet stays if the poll left
 * before it was confirmed.
 */
function keepConfirmed(next: MapleState, prev: MapleState | null, confirmed: Map<number, { updatedAt: string; at: number }>, sentAt: number): MapleState {
  if (!confirmed.size || !prev) return next;
  let changed = false;
  const entries = next.entries.map((e) => {
    const c = confirmed.get(e.id);
    if (!c) return e;
    if (Date.parse(e.updated_at) >= Date.parse(c.updatedAt)) {
      confirmed.delete(e.id);
      return e;
    }
    const mine = prev.entries.find((x) => x.id === e.id);
    if (!mine) return e;
    changed = true;
    return mine;
  });
  for (const [id, c] of confirmed) {
    if (entries.some((e) => e.id === id)) continue;
    const mine = prev.entries.find((x) => x.id === id);
    if (mine && sentAt < c.at) {
      entries.push(mine);
      changed = true;
    } else confirmed.delete(id);
  }
  if (!changed) return next;
  return { ...next, entries: entries.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)) };
}

export function MapleProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [state, setState] = useState<MapleState | null>(null);
  const [units, setUnitsState] = useState<UnitSystem>("us");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tick, setTick] = useState(0);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [online, setOnline] = useState(true);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const offsetRef = useRef(0); // serverNow - clientNow (ms)
  const revRef = useRef<string | null>(null);
  const inflight = useRef(0);
  const flushing = useRef(false);
  const seenRef = useRef(false);
  const lastPollRef = useRef(0);
  const tzRef = useRef("America/New_York");
  /** Entries a timer mutation answered for: id → updated_at (see keepConfirmed). Optimistic copies never go here. */
  const confirmedRef = useRef(new Map<number, { updatedAt: string; at: number }>());
  const stateRef = useRef<MapleState | null>(null);
  stateRef.current = state;
  /** How many holds are on (the Lantern, Fix times); timer toasts wait while any is. */
  const holdRef = useRef(0);
  const heldRef = useRef<{ text: string; opts: Partial<Omit<Toast, "id" | "text">>; at: number; seen: number } | null>(null);
  /** Toasts shown so far: a held timer toast is dropped if a newer one came up (the sheet's own save or undo). */
  const shownRef = useRef(0);
  const queuesRef = useRef(new Map<number, TimerQueue>());
  const [busy, setBusy] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    try {
      const u = localStorage.getItem(UNITS_KEY);
      if (u === "metric" || u === "us") setUnitsState(u);
    } catch {
      // storage blocked
    }
    const queued = readOutbox();
    setOutbox(queued);
    // Queued entries keep their temporary (negative) ids across reloads; new
    // ones must not reuse them.
    for (const i of queued) tempId = Math.min(tempId, (i.entry?.id ?? 0) - 1);
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  }, []);

  const setUnits = useCallback((u: UnitSystem) => {
    setUnitsState(u);
    try {
      localStorage.setItem(UNITS_KEY, u);
    } catch {
      // storage blocked
    }
  }, []);

  const now = useCallback(() => new Date(Date.now() + offsetRef.current), []);
  const isNight = useCallback(() => {
    const h = localParts(now(), tzRef.current).hour;
    return h >= 20 || h < 7;
  }, [now]);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (id: number, text: string, opts: Partial<Omit<Toast, "id" | "text">>) => {
      shownRef.current++;
      // A group holds one toast: the newest timer toast replaces the last.
      setToasts((t) => [...t.filter((x) => !opts.group || x.group !== opts.group).slice(-2), { id, text, tone: opts.tone ?? "ok", ...opts }]);
      const long = opts.undo || opts.actions?.length;
      const ms = opts.duration ?? (long ? (isNight() ? 12_000 : 8_000) : 3_500);
      setTimeout(() => dismissToast(id), ms);
    },
    [dismissToast, isNight]
  );
  const toast = useCallback(
    (text: string, opts: Partial<Omit<Toast, "id" | "text">> = {}) => {
      const id = Date.now() + Math.random();
      if (holdRef.current > 0 && opts.group === "timer") heldRef.current = { text, opts, at: Date.now(), seen: shownRef.current };
      else show(id, text, opts);
      return id;
    },
    [show]
  );
  const dismissTimerToast = useCallback(() => setToasts((t) => (t.some((x) => x.group === "timer") ? t.filter((x) => x.group !== "timer") : t)), []);
  const holdTimerToasts = useCallback(
    (on: boolean) => {
      if (on) {
        if (holdRef.current++ === 0) heldRef.current = null;
        dismissTimerToast();
        return;
      }
      if (holdRef.current === 0) return;
      if (--holdRef.current > 0) return;
      const held = heldRef.current;
      heldRef.current = null;
      // Still worth saying: recent, its entry unchanged, and no toast since. A newer one (the sheet's own save or
      // undo) means the parent has moved on, and two toasts with two Undos would stack over the card.
      const current = () => {
        if (!held || Date.now() - held.at >= TIMER_TOAST_HOLD_MS || shownRef.current !== held.seen) return false;
        const w = held.opts.watch;
        const live = w ? stateRef.current?.entries.find((e) => e.id === w.entryId) : null;
        return !w || (!!live && live.updated_at === w.updatedAt);
      };
      if (!held || !current()) return;
      if (inflight.current === 0) return show(Date.now() + Math.random(), held.text, held.opts);
      // A save the sheet sent as it closed (a new diaper: close, then log) answers with its own toast in a moment:
      // wait for it (up to 3 s), so the held one shows only if nothing newer does. A new hold meanwhile drops it.
      const until = Date.now() + 3000;
      const wait = () => {
        if (holdRef.current > 0 || !current()) return;
        if (inflight.current > 0 && Date.now() < until) return void window.setTimeout(wait, 150);
        show(Date.now() + Math.random(), held.text, held.opts);
      };
      window.setTimeout(wait, 150);
    },
    [dismissTimerToast, show]
  );

  const syncClock = useCallback((serverNow: string) => {
    const t = Date.parse(serverNow);
    if (Number.isFinite(t)) offsetRef.current = t - Date.now();
  }, []);

  const loadAuth = useCallback(async () => {
    try {
      setAuth(await fetchJson<AuthInfo>("/api/maple/auth/me"));
    } catch {
      setAuth({ signedIn: false, google: false, password: false });
    }
  }, []);

  /** Server entries plus anything still waiting in the outbox (care items as pending care entries). */
  const withPending = useCallback((s: MapleState, items: OutboxItem[]): MapleState => {
    if (!items.length) return s;
    const ids = new Set(s.entries.map((e) => e.id));
    const extra = items.filter(isEntryItem).map((i) => i.entry).filter((e) => !ids.has(e.id));
    const entries = extra.length ? [...extra, ...s.entries].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)) : s.entries;
    let care = s.care;
    const careExtra = items.filter(isCareItem).map((i) => ({ ...i.entry, pending: true }) as CareEntry);
    if (care && careExtra.length) {
      const have = new Set(care.entries.map((e) => e.id));
      care = { ...care, entries: [...careExtra.filter((e) => !have.has(e.id)), ...care.entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) };
    }
    return { ...s, entries, ...(care ? { care } : {}) };
  }, []);

  const outboxRef = useRef<OutboxItem[]>([]);
  outboxRef.current = outbox;

  const refresh = useCallback(async () => {
    // Skip polls while a mutation is in flight so we don't flash stale data.
    if (inflight.current > 0) return;
    const sentAt = Date.now();
    try {
      const qs = revRef.current ? `?rev=${encodeURIComponent(revRef.current)}` : "";
      const res = await fetchJson<MapleState | MapleStateUnchanged>(`/api/maple/state${qs}`);
      syncClock(res.now);
      setOnline(true);
      if ("unchanged" in res) {
        lastPollRef.current = Date.now();
        return;
      }
      // "While you slept": the previous visit as of the first poll, and again
      // whenever the app comes back after a long time in the background. Read
      // it before the in-flight check below: the server has already marked
      // this visit, so a dropped response would lose the old value for good.
      const away = Date.now() - lastPollRef.current >= AWAY_MS;
      if (!seenRef.current || away) {
        seenRef.current = true;
        setSeenAt(res.seen_at);
      }
      lastPollRef.current = Date.now();
      if (inflight.current > 0) return;
      revRef.current = res.rev;
      tzRef.current = res.baby.timezone;
      setState((prev) => keepConfirmed(withPending(res, outboxRef.current), prev, confirmedRef.current, sentAt));
      setStatus("ready");
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        revRef.current = null;
        setState(null);
        setStatus("signedOut");
        // Signed out: her doses and check-ins waiting on this phone go, so nothing about her stays behind.
        if (outboxRef.current.some((i) => i.target === "care" || i.target === "mood")) {
          const kept = outboxRef.current.filter((i) => i.target !== "care" && i.target !== "mood");
          setOutbox(kept);
          writeOutbox(kept);
          outboxRef.current = kept;
        }
        void loadAuth();
        return;
      }
      if (!(e instanceof ApiError)) setOnline(false);
      setError(e instanceof Error ? e.message : "Couldn't reach Maple's log");
      setStatus((s) => (s === "loading" ? "error" : s));
    }
  }, [loadAuth, syncClock, withPending]);

  const forceRefresh = useCallback(async () => {
    revRef.current = null;
    await refresh();
  }, [refresh]);

  /** Replace the outbox everywhere at once (state, storage, ref). */
  const setQueue = useCallback((items: OutboxItem[]) => {
    setOutbox(items);
    writeOutbox(items);
    outboxRef.current = items;
  }, []);

  const forceRefreshRef = useRef(forceRefresh);
  forceRefreshRef.current = forceRefresh;

  /**
   * A dose saved on this phone offline turned out to repeat one logged
   * elsewhere meanwhile: nothing was saved, and the toast asks (as the Dose
   * sheet would) before logging it again.
   */
  const careDuplicateToast = useCallback(
    (item: CareItem, dup: DoseEntry) => {
      const s = stateRef.current;
      const who = dup.created_by && dup.created_by === s?.me.email ? "You" : nameOf(dup.created_by, s?.members ?? []);
      const text = `${who} logged ${dup.data.name} at ${formatTime(dup.at, tzRef.current)}. Is this another dose?`;
      toast(text, {
        tone: "info",
        duration: 20_000,
        actions: [
          {
            label: "Yes, another dose",
            onClick: () =>
              void fetchJson("/api/maple/care/entries", { method: "POST", body: JSON.stringify({ ...item.input, allow_duplicate: true }) })
                .then(() => toast("Logged"))
                .catch((e) => toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" }))
                .finally(() => void forceRefreshRef.current()),
          },
          { label: "No, same one", onClick: () => toast("Not saved: it's the same dose", { tone: "info" }) },
        ],
      });
    },
    [toast]
  );

  /**
   * Send anything waiting in the outbox. Entries can be queued or removed
   * while a slow request is in flight, so the result is applied to the
   * current queue by client_id, never by replacing it wholesale.
   */
  const flush = useCallback(async () => {
    if (flushing.current || !outboxRef.current.length) return;
    flushing.current = true;
    const done = new Set<string>();
    const bumped = new Set<string>();
    try {
      for (const item of [...outboxRef.current]) {
        // Removed from the queue while we were busy (the parent deleted it).
        if (!outboxRef.current.some((i) => i.client_id === item.client_id)) continue;
        try {
          const target = item.target ?? "entries";
          const res = await fetchJson<{ entry: { id: number } | null; created?: boolean; possible_duplicate?: DoseEntry }>(OUTBOX_URL[target], {
            method: "POST",
            body: JSON.stringify(item.input),
          });
          done.add(item.client_id);
          if (isCareItem(item) && res.created === false && res.possible_duplicate) {
            // The other phone (or Siri) logged it first: ask instead of saving a second dose.
            careDuplicateToast(item, res.possible_duplicate);
            continue;
          }
          // Deleted on this phone while it was uploading: take it back out.
          if (res.entry && !outboxRef.current.some((i) => i.client_id === item.client_id)) {
            const del = target === "care" ? `/api/maple/care/entries?id=${res.entry.id}` : target === "mood" ? `/api/maple/care/mood?id=${res.entry.id}` : `/api/maple/entries?id=${res.entry.id}`;
            await fetchJson(del, { method: "DELETE" }).catch(() => {});
          }
        } catch (e) {
          if (isTransient(e)) bumped.add(item.client_id);
          else {
            done.add(item.client_id);
            toast(`Couldn't save an earlier entry: ${(e as Error).message}`, { tone: "error", duration: 8000 });
          }
        }
      }
      setQueue(
        outboxRef.current
          .filter((i) => !done.has(i.client_id))
          .map((i) => (bumped.has(i.client_id) ? { ...i, tries: i.tries + 1 } : i))
      );
      if (done.size) {
        setOnline(true);
        await forceRefresh();
      }
    } finally {
      flushing.current = false;
    }
  }, [careDuplicateToast, forceRefresh, setQueue, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useVisiblePoll(() => {
    void flush();
    // Back after hours away: ask for a full snapshot (not just "unchanged") so
    // the "While you slept" recap gets this member's previous visit.
    if (Date.now() - lastPollRef.current >= AWAY_MS) void forceRefresh();
    else void refresh();
  }, POLL_MS);

  useEffect(() => {
    const on = () => {
      setOnline(true);
      void flush();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [flush]);

  // Re-derive the summary every 30s so "2h ago" and gap nudges stay fresh.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const summary = useMemo<Summary | null>(() => {
    if (!state) return null;
    void tick;
    return summarize({
      entries: state.entries,
      growth: state.growth,
      baby: state.baby,
      members: state.members,
      now: now(),
      lifetime: state.lifetime,
    });
  }, [state, tick, now]);

  /**
   * Show a change to one entry at once (optimistic): `make` gets its current
   * copy and returns the new one (null drops it, undefined leaves it alone).
   * The returned rollback puts back only that entry, and only while it still
   * shows one of the early copies in `mine`: a server answer or a poll since
   * then wins, and anything else that changed meanwhile (a diaper logged
   * offline) stays.
   */
  const optimistic = useCallback((id: number, make: (cur: Entry | undefined) => Entry | null | undefined, mine: Set<Entry> = new Set()) => {
    let prev: Entry | undefined;
    let next: Entry | null | undefined;
    setState((s) => {
      if (!s) return s;
      prev = s.entries.find((e) => e.id === id);
      next = make(prev);
      if (next === undefined) return s;
      if (next) mine.add(next);
      const rest = s.entries.filter((e) => e.id !== id);
      return { ...s, entries: next ? byStart([next, ...rest]) : rest };
    });
    return () =>
      setState((s) => {
        if (!s || next === undefined) return s;
        const cur = s.entries.find((e) => e.id === id);
        if (cur ? !mine.has(cur) : next !== null) return s;
        const rest = s.entries.filter((e) => e.id !== id);
        return { ...s, entries: prev ? byStart([prev, ...rest]) : rest };
      });
  }, []);

  const upsert = useCallback(
    (saved: Entry, replaceId?: number) =>
      setState((s) => {
        if (!s) return s;
        const rest = s.entries.filter((e) => e.id !== saved.id && e.id !== replaceId);
        const entries = [saved, ...rest].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
        const growth =
          saved.kind === "growth"
            ? [...s.growth.filter((g) => g.id !== saved.id), saved].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
            : s.growth;
        return { ...s, entries, growth };
      }),
    []
  );

  const dropEntry = useCallback(
    (id: number) =>
      setState((s) => (s ? { ...s, entries: s.entries.filter((e) => e.id !== id), growth: s.growth.filter((g) => g.id !== id) } : s)),
    []
  );

  /** memberLabel for the actions defined before it (reads the state as it is when called). */
  const labelFor = useCallback((id: string | null | undefined) => {
    const s = stateRef.current;
    return s ? labelOf(id, { members: s.members, me: s.me, baby: s.baby }) : null;
  }, []);

  const withInflight = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    inflight.current++;
    try {
      return await fn();
    } finally {
      inflight.current--;
    }
  }, []);

  const restore = useCallback<MapleContextValue["restore"]>(
    async (id, opts = {}) => {
      try {
        const { entry, stopped_at } = await withInflight(() =>
          fetchJson<{ entry: Entry; stopped_at?: string | null }>(`/api/maple/entries/restore?id=${id}`, { method: "POST" })
        );
        upsert(entry);
        if (stopped_at) {
          toast(`Restored, but stopped at ${formatTime(stopped_at, tzRef.current)}: another timer is running now`, { tone: "info" });
        } else if (!opts.quiet) {
          toast("Restored");
        }
        return entry;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't restore", { tone: "error" });
        return null;
      } finally {
        void forceRefresh();
      }
    },
    [forceRefresh, toast, upsert, withInflight]
  );

  const remove = useCallback<MapleContextValue["remove"]>(
    async (id, opts = {}) => {
      // Still in the outbox: just drop it locally.
      const queued = outboxRef.current.filter(isEntryItem).find((i) => i.entry.id === id);
      // Still being saved (temporary id, not queued): nothing to delete yet.
      if (id < 0 && !queued) {
        toast("One sec, that's still saving", { tone: "info" });
        return;
      }
      if (queued) {
        setQueue(outboxRef.current.filter((i) => i.client_id !== queued.client_id));
        dropEntry(id);
        toast(opts.toast ?? "Removed");
        return;
      }
      const kind = stateRef.current?.entries.find((x) => x.id === id)?.kind;
      const rollback = optimistic(id, () => null);
      try {
        await withInflight(() => fetchJson(`/api/maple/entries?id=${id}`, { method: "DELETE" }));
        toast(opts.toast ?? "Deleted", { undo: () => void restore(id) });
      } catch (e) {
        // Someone else deleted it first: it stays gone here too, and the toast says who.
        const gone = discardedLine(e, kind, labelFor);
        if (gone) toast(gone, { tone: "info" });
        else {
          rollback();
          toast(e instanceof Error ? e.message : "Couldn't delete", { tone: "error" });
        }
      } finally {
        void forceRefresh();
      }
    },
    [dropEntry, forceRefresh, labelFor, optimistic, restore, setQueue, toast, withInflight]
  );

  const log = useCallback<MapleContextValue["log"]>(
    async (input, opts = {}) => {
      const s = state;
      const id = tempId--;
      const nowIso = now().toISOString();
      const client_id = input.client_id ?? newClientId();
      const body: CreateEntryInput = { ...input, client_id, started_at: input.started_at ?? nowIso };
      const optimistic = {
        id,
        kind: input.kind,
        started_at: body.started_at!,
        ended_at: input.ended_at ?? null,
        active: false,
        data: (input.data ?? {}) as never,
        note: input.note ?? null,
        created_by: s?.me.email ?? null,
        updated_by: null,
        source: "web",
        created_at: nowIso,
        updated_at: nowIso,
      } as Entry;
      upsert(optimistic);
      try {
        const { entry } = await withInflight(() =>
          fetchJson<{ entry: Entry }>("/api/maple/entries", { method: "POST", body: JSON.stringify(body) })
        );
        upsert(entry, id);
        if (!opts.silent) {
          toast(opts.toast ?? "Logged", {
            undo: () => void remove(entry.id, { toast: "Undone" }),
            actions: opts.actions?.(entry),
            icon: toastIcon(entry),
          });
        }
        return entry;
      } catch (e) {
        if (isTransient(e)) {
          // Keep it: it'll sync when the connection is back.
          setQueue([...outboxRef.current, { client_id, input: body, entry: optimistic, tries: 1 }]);
          setOnline(false);
          toast("Saved on this phone · will sync when you're back online", { tone: "info" });
          return optimistic;
        }
        dropEntry(id);
        toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
        return null;
      } finally {
        void forceRefresh();
      }
    },
    [dropEntry, forceRefresh, now, remove, setQueue, state, toast, upsert, withInflight]
  );

  const update = useCallback<MapleContextValue["update"]>(
    async (id, patch, opts = {}) => {
      if (id < 0) {
        // Not on the server yet. If it's waiting in the outbox, fold the edit
        // into the queued save; otherwise it's mid-save, so ask for a moment.
        const queued = outboxRef.current.filter(isEntryItem).find((i) => i.entry.id === id);
        if (!queued) {
          toast("One sec, that's still saving", { tone: "info" });
          return null;
        }
        const input: CreateEntryInput = {
          ...queued.input,
          ...(patch.started_at ? { started_at: patch.started_at } : {}),
          ...(patch.ended_at !== undefined ? { ended_at: patch.ended_at } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          data: { ...(queued.input.data ?? {}), ...(patch.data ?? {}) },
        };
        const entry = {
          ...queued.entry,
          started_at: input.started_at ?? queued.entry.started_at,
          ended_at: input.ended_at ?? null,
          note: input.note ?? null,
          data: input.data as never,
        } as Entry;
        setQueue(outboxRef.current.map((i) => (i.client_id === queued.client_id ? ({ ...queued, input, entry } as OutboxItem) : i)));
        upsert(entry);
        if (opts.toast !== "") toast(opts.toast ?? "Saved on this phone", { icon: toastIcon(entry) });
        return entry;
      }
      const kind = stateRef.current?.entries.find((x) => x.id === id)?.kind;
      try {
        const { entry } = await withInflight(() =>
          fetchJson<{ entry: Entry }>(`/api/maple/entries?id=${id}`, { method: "PATCH", body: JSON.stringify(patch) })
        );
        upsert(entry);
        if (opts.toast !== "") toast(opts.toast ?? "Saved", { icon: toastIcon(entry) });
        return entry;
      } catch (e) {
        // The other phone discarded it while this sheet was open: say who, and drop it here too.
        const onlyNote = Object.keys(patch).every((k) => k === "note" || k === "expect_updated_at");
        const gone = discardedLine(e, kind, labelFor, onlyNote ? "note" : "change");
        if (gone) {
          dropEntry(id);
          toast(gone, { tone: "info" });
        } else toast(e instanceof Error ? e.message : "Couldn't save", { tone: "error" });
        return null;
      } finally {
        void forceRefresh();
      }
    },
    [dropEntry, forceRefresh, labelFor, setQueue, toast, upsert, withInflight]
  );

  const memberName = useCallback((id: string | null | undefined) => nameOf(id, state?.members ?? []), [state]);

  const memberLabel = useCallback(
    (id: string | null | undefined) => (state ? labelOf(id, { members: state.members, me: state.me, baby: state.baby }) : null),
    [state]
  );

  const confirm = useCallback((e: Entry) => {
    if (e.id > 0) confirmedRef.current.set(e.id, { updatedAt: e.updated_at, at: Date.now() });
  }, []);

  const timerCall = useCallback<MapleContextValue["timerCall"]>(
    async (input, opts = {}) => {
      const fail = (f: TimerFailure, tone: Toast["tone"] = "error", duration?: number) => {
        if (opts.onError) opts.onError(f);
        else if (!(opts.silent409 && f.kind === "changed")) {
          const actions = opts.failActions?.(f);
          toast(opts.failText?.(f) ?? f.message, { tone, duration, ...(actions?.length ? { actions } : {}) });
        }
        // null: the action didn't happen (callers must not toast success or offer Undo).
        return null;
      };
      // A timer that hasn't reached the server yet has a temporary id; acting
      // on it would 400 and lose the tap.
      if (input.id != null && input.id < 0) return fail({ kind: "pending", message: "One sec, that timer is still starting", who: null }, "info");
      const body: TimerCallInput = input.action === "start" ? { ...input, client_id: input.client_id ?? newClientId() } : input;
      // Without a time of its own, a tap happens when the server gets it.
      const atNow = () => (input.at ? new Date(input.at) : now());
      const id = input.id != null && input.id > 0 ? input.id : null;
      let rollback: (() => void) | null = null;
      // Optimistic: reflect the change immediately; the server answer replaces it.
      if (id === null && input.action === "start" && input.kind && state && !state.entries.some((e) => e.active && e.kind === input.kind)) {
        const at = atNow();
        const early = {
          id: tempId--,
          kind: input.kind,
          started_at: at.toISOString(),
          ended_at: null,
          active: true,
          data: input.kind === "feed" ? startBreast(input.side ?? "L", at) : {},
          note: null,
          created_by: state.me.email,
          updated_by: null,
          source: "web",
          created_at: at.toISOString(),
          updated_at: at.toISOString(),
        } as Entry;
        rollback = optimistic(early.id, () => early);
      }
      /**
       * One request at a time per entry, in tap order: a Pause tapped while a
       * slow Switch is still out goes after the Switch's answer, never beside
       * it (whichever landed first used to win).
       */
      let q: TimerQueue | null = null;
      if (id !== null) {
        q = queuesRef.current.get(id) ?? { tail: Promise.resolve(true), n: 0, mine: new Set<Entry>() };
        queuesRef.current.set(id, q);
        q.n++;
        setBusy((b) => (b.has(id) ? b : new Set(b).add(id)));
      }
      const mine = q?.mine;
      /** This tap's early copy, over whatever the entry shows now; `fresh` skips it while an early copy from this queue still shows. */
      const showEarly = (fresh: boolean) =>
        optimistic(
          id!,
          (cur) => {
            if (!cur || (fresh && mine!.has(cur)) || !(cur.active || input.action === "retime")) return undefined;
            return optimisticTimer(cur, input, atNow(), now(), state?.me.email);
          },
          mine
        );
      const waits = !!q && q.n > 1;
      if (q) rollback = showEarly(false);
      const ahead = q?.tail ?? Promise.resolve(true);
      let settle: (happened: boolean) => void = () => {};
      if (q) q.tail = new Promise<boolean>((r) => (settle = r));
      let happened = false;
      // Counted from the tap, not the send, so no poll lands while a tap waits its turn.
      inflight.current++;
      try {
        if (!(await ahead)) {
          // The tap before this one didn't happen (its toast said why), and this one was made on top of it.
          rollback?.();
          return null;
        }
        if (waits) {
          // The answer to the tap before replaced this tap's early copy: show it again, over the server's version.
          const first = rollback;
          const again = showEarly(true);
          rollback = () => {
            again();
            first?.();
          };
        }
        const res = await fetchJson<TimerResponse>("/api/maple/timer", { method: "POST", body: JSON.stringify(body) });
        happened = true;
        const { entry } = res;
        if (input.action === "discard") {
          dropEntry(entry.id);
          confirmedRef.current.delete(entry.id);
        } else {
          // Joined into the feed before it: that one is the feed now.
          if (res.joined) {
            dropEntry(res.joined.id);
            confirmedRef.current.delete(res.joined.id);
          }
          // Drop any optimistic temp timer of the same kind, then upsert the real one.
          setState((s) => (s ? { ...s, entries: s.entries.filter((e) => !(e.id < 0 && e.kind === entry.kind && e.active)) } : s));
          upsert(entry);
          confirm(entry);
        }
        // A nap that moved with the feed start (or came back with a restore).
        if (res.nap?.entry) {
          upsert(res.nap.entry);
          confirm(res.nap.entry);
        }
        return res;
      } catch (e) {
        rollback?.();
        if (e instanceof ApiError && e.status === 409) {
          // The other parent got there first: show what actually happened.
          const b = e.body as { entry?: Entry; reason?: string; error?: string } | null;
          const cur = b?.entry;
          if (cur) {
            upsert(cur);
            confirm(cur);
          }
          const who = memberLabel(cur?.updated_by);
          if (b?.reason === "clash") return fail({ kind: "bad", message: b.error ?? e.message, who, entry: cur }, "info");
          if (b?.reason === "changed" || cur?.active) {
            const what = !cur || cur.kind === "feed" ? "feed" : "timer";
            const message = who ? `${who} just changed this ${what}. Have another look.` : `This ${what} just changed on another device or through Claude. Have another look.`;
            return fail({ kind: "changed", message, who, entry: cur }, "info");
          }
          const when = cur?.ended_at ? ` at ${formatTime(cur.ended_at, tzRef.current)}` : "";
          const message =
            !cur || cur.kind === "feed"
              ? who
                ? `${who} already ended this feed${when}`
                : `This feed already ended${when}`
              : who
                ? `${who} already stopped this timer${when}`
                : `This timer already stopped${when}`;
          return fail({ kind: "stopped", message, who, entry: cur }, "info");
        }
        if (!(e instanceof ApiError)) {
          // Timers need the server's clock, so they aren't queued like entries.
          setOnline(false);
          return fail(
            { kind: "offline", message: "Didn't save: you're offline. Tap again when you're back online, or log it afterwards.", who: null },
            "error",
            8000
          );
        }
        const b = e.body as { code?: string; reason?: string; deleted_by?: string | null } | null;
        if (e.status === 404 && b?.reason === "discarded") {
          // Thrown away on the other phone (or through Claude): say who, and drop it here too.
          if (id !== null) dropEntry(id);
          const who = memberLabel(b.deleted_by);
          return fail({ kind: "gone", message: who ? `${who} discarded this timer` : "This timer was discarded", who }, "info");
        }
        return fail({ kind: e.status === 400 ? "bad" : "error", message: e.message || "Timer hiccup, try again", who: null, code: b?.code ?? undefined });
      } finally {
        inflight.current--;
        settle(happened);
        if (q && id !== null && --q.n === 0) {
          queuesRef.current.delete(id);
          setBusy((b) => {
            if (!b.has(id)) return b;
            const n = new Set(b);
            n.delete(id);
            return n;
          });
        }
        void forceRefresh();
      }
    },
    [confirm, dropEntry, forceRefresh, memberLabel, now, optimistic, state, toast, upsert]
  );

  const timerBusy = useCallback((id: number) => busy.has(id), [busy]);

  const timer = useCallback<MapleContextValue["timer"]>(async (input) => (await timerCall(input))?.entry ?? null, [timerCall]);

  // A timer toast built from an older version of its entry closes once someone else changes it.
  useEffect(() => {
    if (!state) return;
    const stale = toasts.filter((t) => {
      if (!t.watch) return false;
      const live = state.entries.find((e) => e.id === t.watch!.entryId);
      return !live || Date.parse(live.updated_at) > Date.parse(t.watch.updatedAt);
    });
    if (stale.length) setToasts((ts) => ts.filter((t) => !stale.includes(t)));
  }, [state, toasts]);

  const api = useCallback(<T,>(path: string, init?: RequestInit) => fetchJson<T>(path, init), []);

  const member = useCallback(
    (id: string | null | undefined) => (id && state ? state.members.find((m) => m.email === id) ?? null : null),
    [state]
  );

  const readOnly = state?.me.role === "viewer";

  // Stable (memberLabel changes with every poll), so a sheet asking once per disappearance doesn't ask again on each poll.
  const labelRef = useRef(memberLabel);
  useEffect(() => {
    labelRef.current = memberLabel;
  }, [memberLabel]);
  const whoDiscarded = useCallback(async (id: number) => {
    try {
      const r = await fetchJson<{ entries: Entry[] }>("/api/maple/entries?deleted=1");
      const e = r.entries?.find((x) => x.id === id);
      return e ? labelRef.current(e.updated_by) : undefined;
    } catch {
      return undefined;
    }
  }, []);

  const care = useMemo<MapleContextValue["care"]>(
    () => ({
      patch: (fn) => setState((s) => (s?.care ? { ...s, care: fn(s.care) } : s)),
      track: (fn) => withInflight(fn),
      queue: (input, entry) => {
        setQueue([...outboxRef.current, { target: "care", client_id: input.client_id, input, entry, tries: 1 }]);
        setOnline(false);
        setState((s) => (s ? withPending(s, outboxRef.current) : s));
      },
      unqueue: (entryId) => {
        const queued = outboxRef.current.find((i) => isCareItem(i) && i.entry.id === entryId);
        if (!queued) return false;
        setQueue(outboxRef.current.filter((i) => i.client_id !== queued.client_id));
        setState((s) => (s?.care ? { ...s, care: { ...s.care, entries: s.care.entries.filter((e) => e.id !== entryId) } } : s));
        return true;
      },
      tempId: () => tempId--,
    }),
    [setQueue, withInflight, withPending]
  );

  const value = useMemo<MapleContextValue>(
    () => ({
      status,
      error,
      auth,
      state,
      summary,
      now,
      isNight,
      units,
      setUnits,
      refresh: forceRefresh,
      pending: outbox.length,
      online,
      seenAt,
      log,
      update,
      remove,
      restore,
      timerCall,
      timer,
      timerBusy,
      api,
      toasts,
      toast,
      dismissToast,
      dismissTimerToast,
      holdTimerToasts,
      memberName,
      memberLabel,
      whoDiscarded,
      member,
      readOnly,
      care,
    }),
    [status, error, auth, state, summary, now, isNight, units, setUnits, forceRefresh, outbox.length, online, seenAt, log, update, remove, restore, timerCall, timer, timerBusy, api, toasts, toast, dismissToast, dismissTimerToast, holdTimerToasts, memberName, memberLabel, whoDiscarded, member, readOnly, care]
  );

  return <MapleContext.Provider value={value}>{children}</MapleContext.Provider>;
}
