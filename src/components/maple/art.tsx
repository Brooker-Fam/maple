"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useId } from "react";
import { LEAF_GRADIENT, LEAF_LIGHT, LEAF_PATH, LEAF_SHADE, LEAF_SHADE_PATH } from "@/lib/brand";
import { useNightActive } from "./nightLook";

/**
 * Illustrations for Maple's Log: the waiting sapling, crowned with Maple's
 * leaf (src/lib/brand.ts; the leaf on its own is @/components/MapleMark). The
 * app's chrome uses line icons (./icons); these are the few drawn marks.
 * Motion is gentle and switches off under prefers-reduced-motion and the night
 * look.
 */

/** True when the art should hold still. */
export function useStill(): boolean {
  const reduced = useReducedMotion();
  const night = useNightActive();
  return !!reduced || night;
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
      {/* the first maple leaf, crowning it: its stem's tip meets the sapling's at 80,58 */}
      <g transform="translate(54.8 15.5) scale(0.46)">
        <path d={LEAF_PATH} fill={`url(#sap${id})`} />
        <path d={LEAF_SHADE_PATH} fill={`url(#sapShade${id})`} />
      </g>
    </g>
  );
  return (
    <svg viewBox="0 0 160 140" width={size} height={(size * 140) / 160} className="[.maple-night_&]:opacity-75" aria-hidden>
      <defs>
        {[`sap${id}`, `sapShade${id}`].map((gid, k) => (
          <linearGradient key={gid} id={gid} gradientUnits="userSpaceOnUse" x1={LEAF_GRADIENT.x1} y1={LEAF_GRADIENT.y1} x2={LEAF_GRADIENT.x2} y2={LEAF_GRADIENT.y2}>
            {(k ? LEAF_SHADE : LEAF_LIGHT).map((c, i) => (
              <stop key={c} offset={LEAF_GRADIENT.offsets[i]} stopColor={c} />
            ))}
          </linearGradient>
        ))}
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
