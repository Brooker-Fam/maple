"use client";

import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { tick } from "@/components/atlas/haptics";
import { NOTE_TAG_LABELS } from "@/lib/maple/describe";
import { JAUNDICE_LABEL, VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { isVitaminD } from "@/lib/maple/insights";
import { DEFAULT_TZ, dayKey, daysBetween, formatTime, formatTimeNear, parseDayKey } from "@/lib/maple/time";
import type { Baby, Entry, EntryKind, EntryOf } from "@/lib/maple/types";
import { formatTemp, formatVolume, formatWeight } from "@/lib/maple/units";
import { careTime } from "@/lib/maple/care";
import { useCareNav } from "./care/CareNav";
import { useCare } from "./care/useCare";
import { Icon, type IconName } from "./icons";
import { CARE_COLOR, KIND_COLOR, SKIN_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { useTimerActions } from "./TimerCard";
import { Sheet, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * "More": everything that isn't one of the eight everyday dock buttons, as
 * a short list headed by whose it is. Maple: three groups (the daily things,
 * health, words), each with when it was last done ("1.2 oz · Fri 11:05 PM",
 * "4 min today", "2 to ask") instead of a grid of icon tiles; tap logs one
 * now, hold one to log it from earlier. "Maple's medicine" opens on a blank
 * name (vitamin D has its own row), and "For the doctor" opens that sheet
 * at its add field. Then Brittany (for anyone who can log hers): her
 * medicines (the picker), her temperature, and a question for her OB, so
 * nobody logs one of hers in Maple's log by mistake. The sheet scrolls when
 * it doesn't fit.
 */

export const LONG_PRESS_MS = 450;

/**
 * The log-wide switches in Family → On Today (maple_babies.settings, like
 * show_alerts): Bottles ("feeds_bottle": the dock's Bottle tile and the new
 * feed form's Breast/Bottle choice) and Pumping ("track_pump": Pump in
 * More). Both are on unless switched off, so a new log has them. Off only
 * hides the buttons: anything already logged still shows where it is, and
 * Claude and Siri can still log either. (The API checks the same keys:
 * validate.ts LOG_SWITCH_KEYS.)
 */
export function logSwitches(baby: Pick<Baby, "settings"> | null | undefined): { bottles: boolean; pumping: boolean } {
  const s = (baby?.settings ?? {}) as Record<string, unknown>;
  return { bottles: s.feeds_bottle !== false, pumping: s.track_pump !== false };
}

/**
 * After a hold opens a sheet, some phones (iOS) still send a click when the
 * finger lifts, and it lands on whatever the new sheet put under it. Swallow
 * that one click.
 */
function swallowNextClick() {
  const off = () => document.removeEventListener("click", stop, true);
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    off();
  };
  document.addEventListener("click", stop, true);
  window.setTimeout(off, 600);
}

/**
 * Tap vs. press-and-hold on one button. Hold fires after 450ms (with a haptic
 * tick) and swallows the click that follows; moving a finger away cancels.
 */
export function usePress(onTap: () => void, onHold?: () => void) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      held.current = false;
      if (!onHold || e.button !== 0) return;
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        held.current = true;
        tick(15);
        swallowNextClick();
        onHold();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 12) clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: () => {
      if (held.current) {
        held.current = false;
        return;
      }
      onTap();
    },
  };
}

type Item = {
  id: string;
  label: string;
  /** When it was last done, or a short hint when nothing's logged lately. */
  sub?: string;
  icon: IconName;
  color: string;
  onTap: () => void;
  onHold?: () => void;
};

/** Set once someone has held a row, so the "hold" hint stops repeating itself. */
const HELD_KEY = "maple-more-held";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekday = (key: string) => {
  const { year, month, day } = parseDayKey(key);
  return WEEKDAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
};

/** Open doctor questions can be weeks old (older than the app's 72 hours): counted from the full list, fetched once per change to the log. */
let questionCache: { rev: string; open: Map<number, boolean> } | null = null;
const isQuestion = (e: Entry): e is EntryOf<"note"> => e.kind === "note" && !!e.data.for_doctor;

function useOpenQuestions(active: boolean): number {
  const { state, api } = useMaple();
  const rev = state?.rev ?? "";
  const [fetched, setFetched] = useState<Map<number, boolean> | null>(() => questionCache?.open ?? null);
  useEffect(() => {
    if (!active || !rev) return;
    if (questionCache?.rev === rev) {
      setFetched(questionCache.open);
      return;
    }
    let live = true;
    api<{ entries: Entry[] }>("/api/maple/entries?kind=note&limit=500")
      .then((r) => {
        const open = new Map(r.entries.filter(isQuestion).map((q) => [q.id, !q.data.done] as const));
        questionCache = { rev, open };
        if (live) setFetched(open);
      })
      .catch(() => {
        // the loaded days still give a count
      });
    return () => {
      live = false;
    };
  }, [active, api, rev]);
  // Fresh local saves (and ones not yet synced) win over the last fetch.
  const all = new Map(fetched ?? []);
  for (const e of state?.entries ?? []) if (isQuestion(e)) all.set(e.id, !e.data.done);
  return [...all.values()].filter(Boolean).length;
}

export default function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, summary, log, memberName, now, units } = useMaple();
  const sheets = useSheets();
  const care = useCare();
  const careNav = useCareNav();
  const actions = useTimerActions();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const questions = useOpenQuestions(open);
  // Pumping off (Family → On Today): no Pump row; anything already pumped still shows in the log.
  const { pumping } = logSwitches(state?.baby);
  const [held, setHeld] = useState(true);
  useEffect(() => {
    try {
      setHeld(localStorage.getItem(HELD_KEY) === "1");
    } catch {
      setHeld(false);
    }
  }, []);
  const noteHeld = () => {
    if (held) return;
    setHeld(true);
    try {
      localStorage.setItem(HELD_KEY, "1");
    } catch {
      // storage blocked: the hint shows again next time
    }
  };

  const go = (kind: EntryKind, preset?: Record<string, unknown>) => {
    onClose();
    // Let this sheet start closing before the next one opens.
    window.setTimeout(() => sheets.open({ kind, preset }), 120);
  };
  const earlier = (kind: EntryKind, preset: Record<string, unknown> = {}) => () => {
    noteHeld();
    go(kind, { ...preset, started_at: new Date(now().getTime() - 15 * 60_000).toISOString() });
  };

  // ── When each was last done, from the loaded days ──
  const n = now();
  const todayKey = dayKey(n, tz);
  /**
   * "1:15" today (with AM/PM across noon), "11:05 PM" for last night (inside
   * a day, a clock time can only mean one thing), "Thu 4:25 PM" before that.
   */
  const when = (at: string) => {
    const k = dayKey(new Date(at), tz);
    // Today: the time; any other day says which ("Fri 8:50 PM"), so last night's bath doesn't read as this evening.
    if (k === todayKey) return formatTimeNear(at, n, tz);
    return `${daysBetween(k, todayKey) < 7 ? weekday(k) : `${MON[parseDayKey(k).month - 1]} ${parseDayKey(k).day}`} ${formatTime(at, tz)}`;
  };
  /** "today", "Thu", "Oct 12": for a weigh-in, the day is enough. */
  const onDay = (at: string) => {
    const k = dayKey(new Date(at), tz);
    if (k === todayKey) return "today";
    return daysBetween(k, todayKey) < 7 ? weekday(k) : `${MON[parseDayKey(k).month - 1]} ${parseDayKey(k).day}`;
  };
  const entries = state?.entries ?? [];
  const latest = <K extends EntryKind>(kind: K, pred: (e: EntryOf<K>) => boolean = () => true) =>
    entries.find((e) => e.kind === kind && !e.active && pred(e as EntryOf<K>)) as EntryOf<K> | undefined;

  const vitD = summary?.vitaminD;
  const lastVitD = latest("med", (e) => isVitaminD(e.data.name));
  const tummy = summary?.active.find((e) => e.kind === "tummy");
  const tummyMin = Math.round((summary?.today.tummySec ?? 0) / 60);
  const lastTummy = latest("tummy");
  const lastBath = latest("bath");
  const lastPump = latest("pump");
  const pumped = lastPump ? lastPump.data.total_ml ?? ((lastPump.data.left_ml ?? 0) + (lastPump.data.right_ml ?? 0) || null) : null;
  const lastTemp = latest("temp");
  const lastSkin = latest("vitals", (e) => !!e.data.jaundice);
  const lastReading = latest("vitals", (e) => e.data.heart_bpm != null || e.data.resp_rate != null || e.data.spo2 != null);
  const reading = lastReading
    ? lastReading.data.heart_bpm != null
      ? `${lastReading.data.heart_bpm} bpm`
      : lastReading.data.resp_rate != null
        ? `${lastReading.data.resp_rate} breaths`
        : `${lastReading.data.spo2}% O₂`
    : null;
  const lastMed = latest("med", (e) => !isVitaminD(e.data.name));
  const lastNote = latest("note", (e) => !e.data.for_doctor);
  const lastMoment = latest("moment");
  const weight = summary?.weight;

  // Her group: for anyone who can log her doses. The launcher closes before opening hers.
  const openCare = (fn: () => void) => {
    onClose();
    window.setTimeout(fn, 120);
  };
  const baby = (state?.baby.nickname || state?.baby.name || "Maple").split(" ")[0];
  const line = care?.todayLine;
  const lastHerTemp = care?.state.entries
    .filter((e) => e.kind === "temp")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const herQuestions = care?.state.entries.filter((e) => e.kind === "question" && !e.data.done).length ?? 0;
  const mom: Item[] = care?.access.write
    ? [
        {
          id: "mom-meds",
          label: care.self ? "My medicines" : "Her medicines",
          // A half-width cell: the name alone and the glance's first part ("Acetaminophen · OK after 10:55 AM · 4 more").
          sub: line
            ? `${line.view.plan.name} · ${line.view.glance.ready === true ? (line.view.glance.word ?? "") : line.view.glance.detail.split(" · ")[0]}${line.more ? ` · ${line.more} more` : ""}`
            : care.self
              ? "Add your medicines"
              : "Add her medicines",
          icon: "pill",
          color: CARE_COLOR,
          onTap: () => openCare(careNav.openPicker),
        },
        {
          id: "mom-temp",
          label: care.self ? "My temperature" : "Her temperature",
          sub: lastHerTemp?.kind === "temp" ? `${formatTemp(lastHerTemp.data.temp_c, units)} · ${careTime(lastHerTemp.at, n, tz)}` : care.self ? "Log yours" : "Log hers",
          icon: "thermometer",
          color: CARE_COLOR,
          onTap: () => openCare(careNav.openTemp),
        },
        {
          id: "mom-ob",
          label: care.self ? "Question for my OB" : "Question for her OB",
          sub: herQuestions ? `${herQuestions} to ask` : undefined,
          icon: "message-square",
          color: CARE_COLOR,
          onTap: () => openCare(() => careNav.openQuestion()),
        },
      ]
    : [];

  const vitaminD: Item = {
    id: "vitd",
    label: "Vitamin D",
    sub: vitD ? `${formatTimeNear(vitD.givenAt, n, tz)} · ${memberName(vitD.by)}` : lastVitD ? when(lastVitD.started_at) : undefined,
    icon: "sun",
    color: KIND_COLOR.med,
    onTap: () => {
      // One tap logs today's drops; if they're already logged, open the form instead of double-logging.
      if (vitD) return go("med", { ...VITAMIN_D_DEFAULT });
      tick();
      onClose();
      void log({ kind: "med", data: { ...VITAMIN_D_DEFAULT } }, { toast: "Vitamin D drops logged" });
    },
    onHold: earlier("med", { ...VITAMIN_D_DEFAULT }),
  };
  const groups: Item[][] = [
    // The daily things.
    [
      vitaminD,
      {
        id: "tummy",
        label: "Tummy time",
        sub: tummy ? "Running now" : tummyMin > 0 ? `${tummyMin} min today` : lastTummy ? when(lastTummy.started_at) : undefined,
        icon: "tummy",
        color: KIND_COLOR.tummy,
        onTap: () => {
          onClose();
          if (!tummy) void actions.startTimer("tummy");
        },
        onHold: earlier("tummy"),
      },
      { id: "bath", label: "Bath", sub: lastBath && when(lastBath.started_at), icon: "bath", color: KIND_COLOR.bath, onTap: () => go("bath"), onHold: earlier("bath") },
      ...(pumping
        ? [
            {
              id: "pump",
              label: "Pump",
              sub: lastPump && (pumped ? `${formatVolume(pumped, units)} · ${when(lastPump.started_at)}` : when(lastPump.started_at)),
              icon: "milk" as const,
              color: KIND_COLOR.pump,
              onTap: () => go("pump"),
              onHold: earlier("pump"),
            },
          ]
        : []),
    ],
    // Her health.
    [
      {
        id: "temp",
        label: "Temperature",
        sub: lastTemp && `${formatTemp(lastTemp.data.temp_c, units)} · ${when(lastTemp.started_at)}`,
        icon: "thermometer",
        color: KIND_COLOR.temp,
        onTap: () => go("temp"),
        onHold: earlier("temp"),
      },
      {
        id: "skin",
        label: "Skin check",
        sub:
          lastSkin?.data.jaundice &&
          `${lastSkin.data.jaundice === "none" ? JAUNDICE_LABEL.none : `Yellow: ${JAUNDICE_LABEL[lastSkin.data.jaundice].toLowerCase()}`} · ${when(lastSkin.started_at)}`,
        icon: "eye",
        color: SKIN_COLOR,
        onTap: () => go("vitals", { jaundice: "none" }),
        onHold: earlier("vitals", { jaundice: "none" }),
      },
      {
        id: "growth",
        label: "Growth",
        sub: weight ? `${formatWeight(weight.latestG, units)} · ${onDay(weight.at)}` : undefined,
        icon: "ruler",
        color: KIND_COLOR.growth,
        onTap: () => go("growth"),
        onHold: earlier("growth"),
      },
      {
        id: "med",
        label: `${baby}'s medicine`,
        sub: lastMed && `${lastMed.data.name} · ${when(lastMed.started_at)}`,
        icon: "pill",
        color: KIND_COLOR.med,
        // A blank name: vitamin D has its own row, so this one is for anything else.
        onTap: () => go("med", { name: "" }),
        onHold: earlier("med", { name: "" }),
      },
      {
        id: "vitals",
        label: "Other readings",
        sub: lastReading && reading ? `${reading} · ${when(lastReading.started_at)}` : "Heart, breathing",
        icon: "heart-pulse",
        color: KIND_COLOR.vitals,
        onTap: () => go("vitals"),
        onHold: earlier("vitals"),
      },
      {
        id: "doctor",
        label: "For the doctor",
        sub: questions ? `${questions} to ask` : undefined,
        icon: "stethoscope",
        color: KIND_COLOR.vitals,
        onTap: () => openCare(() => careNav.openDoctor({ ask: true })),
      },
    ],
    // Words.
    [
      {
        id: "note",
        label: "Note",
        sub: lastNote ? `${lastNote.data.tag && lastNote.data.tag !== "other" ? `${NOTE_TAG_LABELS[lastNote.data.tag]?.label ?? "Note"} · ` : ""}${when(lastNote.started_at)}` : "Spit-up, hiccups",
        icon: "sticky-note",
        color: KIND_COLOR.note,
        onTap: () => go("note"),
        onHold: earlier("note"),
      },
      { id: "moment", label: "Moment", sub: lastMoment ? when(lastMoment.started_at) : "Photo or words", icon: "camera", color: KIND_COLOR.moment, onTap: () => go("moment") },
    ],
  ];

  return (
    <Sheet open={open} onClose={onClose} title="More to log">
      <section aria-label={baby} className="space-y-3 pb-1">
        {mom.length > 0 && <GroupHeading>{baby}</GroupHeading>}
        {groups.map((g) => (
          <Cells key={g[0].id} items={g} />
        ))}
        {!held && <p className={cx(tone.faint, "pt-1 text-center text-xs")}>Hold one to log an earlier one.</p>}
      </section>
      {mom.length > 0 && care && (
        <section aria-label={care.name} className="space-y-3 pb-1">
          <GroupHeading>{care.name}</GroupHeading>
          <Cells items={mom} />
        </section>
      )}
    </Sheet>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <h3 className={cx(tone.heading, "-mb-1 px-1 text-[15px]")}>{children}</h3>;
}

/** One card of cells, two to a row: hairlines between them, and an odd last one across the whole row. */
function Cells({ items }: { items: Item[] }) {
  const lastRowStart = items.length - (items.length % 2 === 0 ? 2 : 1);
  return (
    <div className={cx(tone.card, "grid grid-cols-2 overflow-hidden")}>
      {items.map((it, i) => (
        // Hairlines between cells: a right edge on the left column, a bottom edge on all but the last row.
        <MoreRow
          key={it.id}
          item={it}
          className={cx(i === items.length - 1 && i % 2 === 0 ? "col-span-2" : i % 2 === 0 && "border-r", i < lastRowStart && "border-b")}
        />
      ))}
    </div>
  );
}

function MoreRow({ item, className }: { item: Item; className?: string }) {
  const press = usePress(item.onTap, item.onHold);
  return (
    <button
      type="button"
      {...press}
      className={cx(
        "flex min-h-[52px] items-start gap-2.5 border-mp-line px-3 py-3 text-left transition select-none active:bg-mp-ink/[0.04]",
        className
      )}
      style={{ WebkitTouchCallout: "none" }}
    >
      {/* A bare icon in the kind's color (amber at night); the label says what it is. */}
      <Icon name={item.icon} size={20} className="mp-kind-ink mt-px shrink-0" style={{ color: item.color }} />
      <span className="min-w-0">
        <span className={cx(tone.body, "block text-[15px] leading-snug font-medium")}>{item.label}</span>
        {item.sub && (
          <span className="mt-0.5 block text-[12px] leading-snug text-mp-ink-2 tabular-nums">
            {/* A narrow cell wraps between parts ("Yellow: face ·" / "10:05 AM"), never inside a time. */}
            {item.sub.split(" · ").map((part, i) => (
              <Fragment key={i}>
                {i > 0 && " · "}
                {/* A part wider than the cell is cut, never spilled into the next cell. */}
                <span className="inline-block max-w-full truncate align-top">{part}</span>
              </Fragment>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}
