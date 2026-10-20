"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { tick } from "@/components/atlas/haptics";
import { VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { DEFAULT_TZ, formatTime } from "@/lib/maple/time";
import type { EntryKind } from "@/lib/maple/types";
import { KIND_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { useTimerActions } from "./TimerCard";
import { Sheet, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * The "More" grid: everything that isn't one of the eight everyday dock
 * buttons. Plain labels, with a soft subline for the whimsy ("sunshine drops").
 * Hold any tile to log one from earlier.
 */

export const LONG_PRESS_MS = 450;

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
  sub: string;
  emoji: string;
  color: string;
  onTap: () => void;
  onHold?: () => void;
};

export default function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, summary, log, memberName, now } = useMaple();
  const sheets = useSheets();
  const actions = useTimerActions();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;

  const go = (kind: EntryKind, preset?: Record<string, unknown>) => {
    onClose();
    // Let this sheet start closing before the next one opens.
    window.setTimeout(() => sheets.open({ kind, preset }), 120);
  };
  const earlier = (kind: EntryKind, preset: Record<string, unknown> = {}) => () =>
    go(kind, { ...preset, started_at: new Date(now().getTime() - 15 * 60_000).toISOString() });

  const vitD = summary?.vitaminD;
  const tummy = summary?.active.find((e) => e.kind === "tummy");

  const items: Item[] = [
    {
      id: "vitd",
      label: "Vitamin D",
      sub: vitD ? `✓ ${formatTime(vitD.givenAt, tz)} · ${memberName(vitD.by)}` : "sunshine drops",
      emoji: "☀️",
      color: KIND_COLOR.med,
      onTap: () => {
        // One tap logs today's drops; if they're already logged, open the form instead of double-logging.
        if (vitD) return go("med", { ...VITAMIN_D_DEFAULT });
        tick();
        onClose();
        void log({ kind: "med", data: { ...VITAMIN_D_DEFAULT } }, { toast: "Vitamin D drops ✓", emoji: "☀️" });
      },
      onHold: earlier("med", { ...VITAMIN_D_DEFAULT }),
    },
    { id: "temp", label: "Temperature", sub: "thermometer", emoji: "🌡️", color: KIND_COLOR.temp, onTap: () => go("temp"), onHold: earlier("temp") },
    {
      id: "tummy",
      label: "Tummy time",
      sub: tummy ? "running now" : "starts a timer",
      emoji: "🐢",
      color: KIND_COLOR.tummy,
      onTap: () => {
        onClose();
        if (!tummy) void actions.startTimer("tummy");
      },
      onHold: earlier("tummy"),
    },
    { id: "pump", label: "Pump", sub: "milk for later", emoji: "🫙", color: KIND_COLOR.pump, onTap: () => go("pump"), onHold: earlier("pump") },
    { id: "med", label: "Medicine", sub: "anything given", emoji: "💊", color: KIND_COLOR.med, onTap: () => go("med"), onHold: earlier("med") },
    { id: "growth", label: "Growth", sub: "weight & length", emoji: "📏", color: KIND_COLOR.growth, onTap: () => go("growth"), onHold: earlier("growth") },
    { id: "bath", label: "Bath", sub: "splish", emoji: "🛁", color: KIND_COLOR.bath, onTap: () => go("bath"), onHold: earlier("bath") },
    { id: "note", label: "Note", sub: "spit-up, hiccups…", emoji: "📝", color: KIND_COLOR.note, onTap: () => go("note"), onHold: earlier("note") },
    {
      id: "doctor",
      label: "Question for the doctor",
      sub: "for the next visit",
      emoji: "🩺",
      color: KIND_COLOR.vitals,
      onTap: () => go("note", { for_doctor: true }),
    },
    { id: "moment", label: "Moment / Photo", sub: "keep this one", emoji: "📸", color: KIND_COLOR.moment, onTap: () => go("moment") },
    {
      id: "skin",
      label: "Skin check",
      sub: "jaundice, in daylight",
      emoji: "🌼",
      color: "#C9962A",
      onTap: () => go("vitals", { jaundice: "none" }),
      onHold: earlier("vitals", { jaundice: "none" }),
    },
    { id: "vitals", label: "Other readings", sub: "heart, breathing", emoji: "💓", color: KIND_COLOR.vitals, onTap: () => go("vitals"), onHold: earlier("vitals") },
  ];

  return (
    <Sheet open={open} onClose={onClose} title="More to log" emoji="🍂">
      <div className="grid grid-cols-3 gap-2 pb-2">
        {items.map((it) => (
          <MoreTile key={it.id} item={it} />
        ))}
      </div>
      <p className={cx(tone.muted, "pb-1 text-center text-xs")}>Hold a button to log one from earlier.</p>
    </Sheet>
  );
}

function MoreTile({ item }: { item: Item }) {
  const press = usePress(item.onTap, item.onHold);
  return (
    <button
      type="button"
      {...press}
      className="flex min-h-[92px] flex-col items-center justify-center gap-1 rounded-2xl px-1.5 py-2 text-center transition select-none active:scale-[0.97]"
      style={{ backgroundColor: `${item.color}18`, boxShadow: `inset 0 0 0 1.5px ${item.color}40`, WebkitTouchCallout: "none" }}
    >
      <span aria-hidden className="text-2xl leading-none">
        {item.emoji}
      </span>
      <span className={cx(tone.body, "text-[14px] leading-tight font-semibold")}>{item.label}</span>
      <span className={cx(tone.muted, "text-[11px] leading-tight")}>{item.sub}</span>
    </button>
  );
}
