"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useId, useMemo } from "react";
import { useNightActive } from "./nightLook";

/**
 * Illustrations for Maple's Log: the sugar-maple leaf (same shape as the app
 * icon: sign-in, the birth welcome, the join and connect pages, the birth
 * banner) and the waiting sapling. Fireflies is kept for a future
 * celebration but nothing shows it now (no ambient motion). The app's chrome
 * uses line icons (./icons); these are the few drawn marks. Motion is gentle
 * and switches off under prefers-reduced-motion and the night look.
 */

/** The app-icon leaf, stem included, in a 100×100 box. */
export const LEAF_PATH =
  "M50 4 L55.5 15.5 L62.5 11.5 L60.5 28 Q61.5 36.5 69.5 32.5 L77 22.5 L81 28 L95 24.5 L88.5 37.5 L94 42 L80.5 50.5 Q75 58.5 67.5 55.5 L72 64 L60 61.5 L53.6 66 L51.7 67.5 L52.9 86 L47.1 86 L48.3 67.5 L46.4 66 L40 61.5 L28 64 L32.5 55.5 Q25 58.5 19.5 50.5 L6 42 L11.5 37.5 L5 24.5 L19 28 L23 22.5 L30.5 32.5 Q38.5 36.5 39.5 28 L37.5 11.5 L44.5 15.5 L50 4 Z";

/** A maple leaf. `color` gives a flat fill; otherwise the icon's autumn gradient. */
export function MapleLeaf({
  size = 48,
  color,
  veins = true,
  className,
}: {
  size?: number;
  color?: string;
  veins?: boolean;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      {!color && (
        <defs>
          <linearGradient id={`leaf${id}`} x1="0.2" y1="0" x2="0.75" y2="1">
            <stop offset="0" stopColor="#E8902F" />
            <stop offset="0.55" stopColor="#CC4A2A" />
            <stop offset="1" stopColor="#A3321F" />
          </linearGradient>
        </defs>
      )}
      <path d={LEAF_PATH} fill={color ?? `url(#leaf${id})`} />
      {veins && (
        <path
          d="M50 64V13M50 58L86 28.5M50 58L14 28.5"
          stroke="#F8DB97"
          strokeOpacity={0.55}
          strokeWidth={1.8}
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  );
}

/** Deterministic 0–1 noise so layouts don't jump between renders. */
const rand = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** True when the art should hold still. */
export function useStill(): boolean {
  const reduced = useReducedMotion();
  const night = useNightActive();
  return !!reduced || night;
}

/** Glowing dots drifting in the dusk. At night: one slow firefly, or none when still. */
export function Fireflies({ count = 7, className }: { count?: number; className?: string }) {
  const reduced = useReducedMotion();
  const night = useNightActive();
  const n = reduced ? 0 : night ? Math.min(1, count) : count;
  const flies = useMemo(
    () =>
      Array.from({ length: n }, (_, i) => ({
        left: 8 + rand(i, 1) * 84,
        top: 10 + rand(i, 2) * 70,
        dx: (rand(i, 3) - 0.5) * 40,
        dy: (rand(i, 4) - 0.5) * 30,
        dur: (night ? 9 : 4) + rand(i, 5) * 4,
        delay: rand(i, 6) * 3,
        size: 4 + rand(i, 7) * 3,
      })),
    [n, night]
  );
  if (!n) return null;
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ""}`} aria-hidden>
      {flies.map((f, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full bg-[#F4D27A] shadow-[0_0_10px_3px_rgba(244,210,122,0.55)]"
          style={{ left: `${f.left}%`, top: `${f.top}%`, width: f.size, height: f.size }}
          animate={{ x: [0, f.dx, 0], y: [0, f.dy, 0], opacity: [0, 0.9, 0.2, 0.85, 0] }}
          transition={{ duration: f.dur, delay: f.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

/** A little maple sapling on a mossy mound, with a toadstool keeping it company. */
export function Sapling({ size = 160, sway = true }: { size?: number; sway?: boolean }) {
  const still = useStill();
  const id = useId().replace(/:/g, "");
  const top = (
    <g>
      <path d="M80 104 C79 88 82 74 80 58" stroke="#5C7A4A" strokeWidth="4" strokeLinecap="round" fill="none" />
      {/* two small side leaves */}
      <path d="M80 86 C70 84 63 78 61 70 C70 70 77 75 80 86 Z" fill="#6B8448" />
      <path d="M80.5 78 C90 76 96 70 98 62 C89 62 83 67 80.5 78 Z" fill="#7F9A57" />
      {/* the first maple leaf, crowning it */}
      <g transform="translate(57 18) scale(0.46)">
        <path d={LEAF_PATH} fill={`url(#sap${id})`} />
      </g>
    </g>
  );
  return (
    <svg viewBox="0 0 160 140" width={size} height={(size * 140) / 160} className="[.maple-night_&]:opacity-75" aria-hidden>
      <defs>
        <linearGradient id={`sap${id}`} x1="0.2" y1="0" x2="0.75" y2="1">
          <stop offset="0" stopColor="#E8902F" />
          <stop offset="0.55" stopColor="#CC4A2A" />
          <stop offset="1" stopColor="#A3321F" />
        </linearGradient>
      </defs>
      {/* mound */}
      <path d="M18 122 C34 98 126 98 142 122 Z" fill="#8A5A2B" opacity="0.9" />
      <path d="M22 118 C40 100 120 100 138 118 C118 110 42 110 22 118 Z" fill="#6B8448" />
      {/* toadstool */}
      <rect x="117" y="104" width="6" height="12" rx="3" fill="#F5EDDF" />
      <path d="M109 106 C110 96 130 96 131 106 Z" fill="#B5452B" />
      <circle cx="116" cy="101.5" r="1.6" fill="#FDF8F0" />
      <circle cx="123.5" cy="100" r="1.4" fill="#FDF8F0" />
      <circle cx="127" cy="104" r="1.1" fill="#FDF8F0" />
      {/* pebbles + a fallen leaf */}
      <ellipse cx="44" cy="114" rx="5" ry="2.6" fill="#B9A58A" />
      <g transform="translate(30 104) rotate(-28) scale(0.12)">
        <path d={LEAF_PATH} fill="#E8902F" />
      </g>
      {sway && !still ? (
        <motion.g
          // Pivot at the foot of the stem (bottom-centre of the group's box).
          style={{ originX: 0.5, originY: 1 }}
          animate={{ rotate: [-2.5, 2.5, -2.5] }}
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
        >
          {top}
        </motion.g>
      ) : (
        top
      )}
    </svg>
  );
}
