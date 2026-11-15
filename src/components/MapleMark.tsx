import { useId } from "react";
import { LEAF_GRADIENT, LEAF_LIGHT, LEAF_PATH, LEAF_SHADE, LEAF_SHADE_PATH } from "@/lib/brand";

/**
 * Maple's leaf (src/lib/brand.ts), for the site and the app alike: the
 * two-tone autumn mark, or one flat `color`. It uses no hooks but useId, so
 * server and client components can both draw it.
 */
export default function MapleMark({ size = 32, color, className }: { size?: number; color?: string; className?: string }) {
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden focusable="false">
      {color ? (
        <path d={LEAF_PATH} fill={color} />
      ) : (
        <>
          <defs>
            <Fill id={`${id}l`} colors={LEAF_LIGHT} />
            <Fill id={`${id}s`} colors={LEAF_SHADE} />
          </defs>
          <path d={LEAF_PATH} fill={`url(#${id}l)`} />
          <path d={LEAF_SHADE_PATH} fill={`url(#${id}s)`} />
        </>
      )}
    </svg>
  );
}

function Fill({ id, colors }: { id: string; colors: readonly string[] }) {
  const { x1, y1, x2, y2, offsets } = LEAF_GRADIENT;
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
      {colors.map((c, i) => (
        <stop key={c} offset={offsets[i]} stopColor={c} />
      ))}
    </linearGradient>
  );
}
