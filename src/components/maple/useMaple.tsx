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
import { finalizeBreast, pause as pauseFeed, retimeBreast, startBreast, switchTo } from "@/lib/maple/feed";
import { summarize, memberName as nameOf, type Summary } from "@/lib/maple/insights";
import { formatTime, localParts } from "@/lib/maple/time";
import type {
  CreateEntryInput,
  Entry,
  FeedData,
  MapleState,
  MapleStateUnchanged,
  Member,
  TimerInput,
  UnitSystem,
  UpdateEntryInput,
} from "@/lib/maple/types";

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

export type ToastAction = { label: string; onClick: () => void; color?: string; ariaLabel?: string };

export type Toast = {
  id: number;
  text: string;
  tone: "ok" | "error" | "info";
  emoji?: string;
  undo?: () => void;
  /** Extra inline buttons (e.g. stool-color swatches after "Poop"). */
  actions?: ToastAction[];
  /** Milliseconds; default 3.5s, or longer with undo/actions (8s by day, 12s at night). */
  duration?: number;
};

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
    opts?: { toast?: string; emoji?: string; silent?: boolean; actions?: (entry: Entry) => ToastAction[] }
  ) => Promise<Entry | null>;
  update: (id: number, patch: UpdateEntryInput, opts?: { toast?: string }) => Promise<Entry | null>;
  remove: (id: number, opts?: { toast?: string }) => Promise<void>;
  restore: (id: number) => Promise<Entry | null>;
  timer: (input: TimerInput) => Promise<Entry | null>;
  /** Raw JSON fetch against /api/maple; throws ApiError (with .status, .body). */
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  toasts: Toast[];
  toast: (text: string, opts?: Partial<Omit<Toast, "id" | "text">>) => void;
  dismissToast: (id: number) => void;
  memberName: (id: string | null | undefined) => string;
  member: (id: string | null | undefined) => Member | null;
  /** True for read-only viewers (hide logging controls). */
  readOnly: boolean;
};

const MapleContext = createContext<MapleContextValue | null>(null);

export function useMaple(): MapleContextValue {
  const ctx = useContext(MapleContext);
  if (!ctx) throw new Error("useMaple must be used inside <MapleProvider>");
  return ctx;
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

type OutboxItem = { client_id: string; input: CreateEntryInput; entry: Entry; tries: number };

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
    for (const i of queued) tempId = Math.min(tempId, i.entry.id - 1);
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
  const toast = useCallback(
    (text: string, opts: Partial<Omit<Toast, "id" | "text">> = {}) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-2), { id, text, tone: opts.tone ?? "ok", ...opts }]);
      const long = opts.undo || opts.actions?.length;
      const ms = opts.duration ?? (long ? (isNight() ? 12_000 : 8_000) : 3_500);
      setTimeout(() => dismissToast(id), ms);
    },
    [dismissToast, isNight]
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

  /** Server entries plus anything still waiting in the outbox. */
  const withPending = useCallback((s: MapleState, items: OutboxItem[]): MapleState => {
    if (!items.length) return s;
    const ids = new Set(s.entries.map((e) => e.id));
    const extra = items.map((i) => i.entry).filter((e) => !ids.has(e.id));
    const entries = [...extra, ...s.entries].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    return { ...s, entries };
  }, []);

  const outboxRef = useRef<OutboxItem[]>([]);
  outboxRef.current = outbox;

  const refresh = useCallback(async () => {
    // Skip polls while a mutation is in flight so we don't flash stale data.
    if (inflight.current > 0) return;
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
      setState(withPending(res, outboxRef.current));
      setStatus("ready");
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        revRef.current = null;
        setState(null);
        setStatus("signedOut");
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
          const { entry } = await fetchJson<{ entry: Entry }>("/api/maple/entries", {
            method: "POST",
            body: JSON.stringify(item.input),
          });
          done.add(item.client_id);
          // Deleted on this phone while it was uploading: take it back out.
          if (!outboxRef.current.some((i) => i.client_id === item.client_id)) {
            await fetchJson(`/api/maple/entries?id=${entry.id}`, { method: "DELETE" }).catch(() => {});
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
  }, [forceRefresh, setQueue, toast]);

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

  /** Apply a local change to entries (optimistic), returning a rollback. */
  const patchEntries = useCallback((fn: (entries: Entry[]) => Entry[]) => {
    let before: MapleState | null = null;
    setState((s) => {
      before = s;
      return s ? { ...s, entries: fn(s.entries) } : s;
    });
    return () => setState(before);
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

  const withInflight = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    inflight.current++;
    try {
      return await fn();
    } finally {
      inflight.current--;
    }
  }, []);

  const restore = useCallback<MapleContextValue["restore"]>(
    async (id) => {
      try {
        const { entry, stopped_at } = await withInflight(() =>
          fetchJson<{ entry: Entry; stopped_at?: string | null }>(`/api/maple/entries/restore?id=${id}`, { method: "POST" })
        );
        upsert(entry);
        if (stopped_at) {
          toast(`Restored, but stopped at ${formatTime(stopped_at, tzRef.current)}: another timer is running now`, {
            emoji: "🍁",
            tone: "info",
          });
        } else {
          toast("Restored", { emoji: "🍁" });
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
      const queued = outboxRef.current.find((i) => i.entry.id === id);
      // Still being saved (temporary id, not queued): nothing to delete yet.
      if (id < 0 && !queued) {
        toast("One sec, that's still saving", { emoji: "⏳", tone: "info" });
        return;
      }
      if (queued) {
        setQueue(outboxRef.current.filter((i) => i.client_id !== queued.client_id));
        dropEntry(id);
        toast(opts.toast ?? "Removed", { emoji: "🍂" });
        return;
      }
      const rollback = patchEntries((es) => es.filter((e) => e.id !== id));
      try {
        await withInflight(() => fetchJson(`/api/maple/entries?id=${id}`, { method: "DELETE" }));
        toast(opts.toast ?? "Deleted", { emoji: "🍂", undo: () => void restore(id) });
      } catch (e) {
        rollback();
        toast(e instanceof Error ? e.message : "Couldn't delete", { tone: "error" });
      } finally {
        void forceRefresh();
      }
    },
    [dropEntry, forceRefresh, patchEntries, restore, setQueue, toast, withInflight]
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
            emoji: opts.emoji,
            undo: () => void remove(entry.id, { toast: "Undone" }),
            actions: opts.actions?.(entry),
          });
        }
        return entry;
      } catch (e) {
        if (isTransient(e)) {
          // Keep it: it'll sync when the connection is back.
          setQueue([...outboxRef.current, { client_id, input: body, entry: optimistic, tries: 1 }]);
          setOnline(false);
          toast("Saved on this phone · will sync when you're back online", { emoji: "🍂", tone: "info" });
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
        const queued = outboxRef.current.find((i) => i.entry.id === id);
        if (!queued) {
          toast("One sec, that's still saving", { emoji: "⏳", tone: "info" });
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
        setQueue(outboxRef.current.map((i) => (i.client_id === queued.client_id ? { ...i, input, entry } : i)));
        upsert(entry);
        if (opts.toast !== "") toast(opts.toast ?? "Saved on this phone", { emoji: "🍂" });
        return entry;
      }
      try {
        const { entry } = await withInflight(() =>
          fetchJson<{ entry: Entry }>(`/api/maple/entries?id=${id}`, { method: "PATCH", body: JSON.stringify(patch) })
        );
        upsert(entry);
        if (opts.toast !== "") toast(opts.toast ?? "Saved", { emoji: "🍁" });
        return entry;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't save", { tone: "error" });
        return null;
      } finally {
        void forceRefresh();
      }
    },
    [forceRefresh, setQueue, toast, upsert, withInflight]
  );

  const memberName = useCallback((id: string | null | undefined) => nameOf(id, state?.members ?? []), [state]);

  const timer = useCallback<MapleContextValue["timer"]>(
    async (input) => {
      // A timer that hasn't reached the server yet has a temporary id; acting
      // on it would 400 and lose the tap.
      if (input.id != null && input.id < 0) {
        toast("One sec, that timer is still starting", { emoji: "⏳", tone: "info" });
        return null;
      }
      // Optimistic: reflect the change immediately; the server answer replaces it.
      const at = input.at ? new Date(input.at) : now();
      const body: TimerInput = input.action === "start" ? { ...input, client_id: input.client_id ?? newClientId() } : input;
      let rollback: (() => void) | null = null;
      if (state) {
        const running = input.id ? state.entries.find((e) => e.id === input.id) : undefined;
        if (input.action === "start" && input.kind && !state.entries.some((e) => e.active && e.kind === input.kind)) {
          const optimistic = {
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
          rollback = patchEntries((es) => [optimistic, ...es]);
        } else if (running?.active) {
          const next = (() => {
            if (input.action === "discard") return null;
            if (input.action === "adjust") {
              // A nursing session's first side starts when it does (the server agrees).
              let data = running.data;
              if (running.kind === "feed") {
                try {
                  data = retimeBreast(running.data as FeedData, { start: at });
                } catch {
                  // the server will say why
                }
              }
              return { ...running, started_at: at.toISOString(), data };
            }
            if (running.kind === "feed") {
              const d = running.data as FeedData;
              if (input.action === "switch" || input.action === "resume") return { ...running, data: switchTo(d, input.side ?? "L", at) };
              if (input.action === "pause") return { ...running, data: pauseFeed(d, at) };
              if (input.action === "stop") return { ...running, active: false, ended_at: at.toISOString(), data: finalizeBreast(d, at) };
            }
            if (input.action === "stop") return { ...running, active: false, ended_at: at.toISOString() };
            return running;
          })() as Entry | null;
          rollback = patchEntries((es) => (next ? es.map((e) => (e.id === running.id ? next : e)) : es.filter((e) => e.id !== running.id)));
        }
      }
      try {
        const { entry } = await withInflight(() =>
          fetchJson<{ entry: Entry }>("/api/maple/timer", { method: "POST", body: JSON.stringify(body) })
        );
        if (input.action === "discard") {
          dropEntry(entry.id);
        } else {
          // Drop any optimistic temp timer of the same kind, then upsert the real one.
          setState((s) => (s ? { ...s, entries: s.entries.filter((e) => !(e.id < 0 && e.kind === entry.kind && e.active)) } : s));
          upsert(entry);
        }
        return entry;
      } catch (e) {
        rollback?.();
        if (e instanceof ApiError && e.status === 409) {
          // The other parent got there first: show what actually happened.
          const body = e.body as { entry?: Entry; reason?: string } | null;
          const cur = body?.entry;
          if (cur) upsert(cur);
          if (body?.reason === "changed" || cur?.active) {
            toast("Someone else just changed that timer. Have another look.", { emoji: "🍃", tone: "info" });
            return null;
          }
          const who = cur?.updated_by && cur.updated_by !== state?.me.email ? memberName(cur.updated_by) : null;
          const when = cur?.ended_at ? ` at ${formatTime(cur.ended_at, tzRef.current)}` : "";
          toast(who ? `${who} already stopped it${when}` : `Already stopped${when}`, { emoji: "🍃", tone: "info" });
          // null: the action didn't happen (callers must not toast success or offer Undo).
          return null;
        }
        if (!(e instanceof ApiError)) {
          // Timers need the server's clock, so they aren't queued like entries.
          setOnline(false);
          toast("Didn't save: you're offline. Tap again when you're back online, or log it afterwards.", {
            tone: "error",
            duration: 8000,
          });
          return null;
        }
        toast(e.message || "Timer hiccup, try again", { tone: "error" });
        return null;
      } finally {
        void forceRefresh();
      }
    },
    [dropEntry, forceRefresh, memberName, now, patchEntries, state, toast, upsert, withInflight]
  );

  const api = useCallback(<T,>(path: string, init?: RequestInit) => fetchJson<T>(path, init), []);

  const member = useCallback(
    (id: string | null | undefined) => (id && state ? state.members.find((m) => m.email === id) ?? null : null),
    [state]
  );

  const readOnly = state?.me.role === "viewer";

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
      timer,
      api,
      toasts,
      toast,
      dismissToast,
      memberName,
      member,
      readOnly,
    }),
    [status, error, auth, state, summary, now, isNight, units, setUnits, forceRefresh, outbox.length, online, seenAt, log, update, remove, restore, timer, api, toasts, toast, dismissToast, memberName, member, readOnly]
  );

  return <MapleContext.Provider value={value}>{children}</MapleContext.Provider>;
}
