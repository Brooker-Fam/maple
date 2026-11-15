/**
 * Maple's mark, drawn once: a young sugar-maple leaf on a curved stem, in a
 * 100×100 box. The site, the app, the social cards and every icon file draw it
 * from here; `pnpm brand:render` (scripts/brand/render.ts) redraws the icon
 * files. Rules and where each file goes: docs/brand.md.
 *
 * The outline is exact arcs, lines and curves, mirrored down the midrib, so it
 * stays clean from a 16 px tab to a 1024 px app icon.
 */

/** The whole leaf, stem included. */
export const LEAF_PATH =
  "M52.12 8.63L55.25 14.56A1.3 1.3 0 0 0 56.89 15.15L61.29 13.35A1.8 1.8 0 0 1 63.73 14.93Q64.01 22.19 63.12 29.36A2.2 2.2 0 0 0 67.02 31.52L74.83 24.24A2.2 2.2 0 0 1 78.21 24.7L80.1 27.78A1.3 1.3 0 0 0 81.53 28.36L88.94 26.46A2.6 2.6 0 0 1 91.89 30.18L88.42 36.79A1.4 1.4 0 0 0 88.57 38.31L90.79 41.09A2 2 0 0 1 90.48 43.86Q82.89 49.98 73.95 53.84A2.4 2.4 0 0 0 72.54 57.06L74.24 61.18A2.53 2.53 0 0 1 71.07 64.53L61.47 61.18A2.2 2.2 0 0 0 59.47 61.46L52.5 66.4C52.25 74.65 52.06 84.1 56.16 91.55A1.6 1.6 0 0 1 53.44 93.25C48.34 85.51 47.79 75.39 47.5 66.4L40.53 61.46A2.2 2.2 0 0 0 38.53 61.18L28.93 64.53A2.53 2.53 0 0 1 25.76 61.18L27.46 57.06A2.4 2.4 0 0 0 26.05 53.84Q17.11 49.98 9.52 43.86A2 2 0 0 1 9.21 41.09L11.43 38.31A1.4 1.4 0 0 0 11.58 36.79L8.11 30.18A2.6 2.6 0 0 1 11.06 26.46L18.47 28.36A1.3 1.3 0 0 0 19.9 27.78L21.79 24.7A2.2 2.2 0 0 1 25.17 24.24L32.98 31.52A2.2 2.2 0 0 0 36.88 29.36Q35.99 22.19 36.27 14.93A1.8 1.8 0 0 1 38.71 13.35L43.11 15.15A1.3 1.3 0 0 0 44.75 14.56L47.88 8.63A2.4 2.4 0 0 1 52.12 8.63Z";

/**
 * The half right of the midrib, stem included below where it crosses. Drawn
 * over LEAF_PATH a shade deeper (LEAF_SHADE), it folds the leaf gently along
 * its center, as if the light came from the left.
 */
export const LEAF_SHADE_PATH =
  "M50 7.35A2.4 2.4 0 0 1 52.12 8.63L55.25 14.56A1.3 1.3 0 0 0 56.89 15.15L61.29 13.35A1.8 1.8 0 0 1 63.73 14.93Q64.01 22.19 63.12 29.36A2.2 2.2 0 0 0 67.02 31.52L74.83 24.24A2.2 2.2 0 0 1 78.21 24.7L80.1 27.78A1.3 1.3 0 0 0 81.53 28.36L88.94 26.46A2.6 2.6 0 0 1 91.89 30.18L88.42 36.79A1.4 1.4 0 0 0 88.57 38.31L90.79 41.09A2 2 0 0 1 90.48 43.86Q82.89 49.98 73.95 53.84A2.4 2.4 0 0 0 72.54 57.06L74.24 61.18A2.53 2.53 0 0 1 71.07 64.53L61.47 61.18A2.2 2.2 0 0 0 59.47 61.46L52.5 66.4C52.25 74.65 52.06 84.1 56.16 91.55A1.6 1.6 0 0 1 53.44 93.25C51.93 90.96 50.82 88.46 50 85.84L50 7.35Z";

/** Where the leaf sits in its 100×100 box: even margins, a little more above than below. */
export const LEAF_BOUNDS = { x: 7.82, y: 7.35, width: 84.37, height: 86.65 } as const;

/** A square crop that fits the leaf, for favicons and tight inline marks. */
export const LEAF_VIEWBOX = "6 6.68 88 88";

/**
 * The same leaf, 19 units tall and centered on 0,0, for small leaves inside
 * other drawings: the tree on Today, the day dial's hand, keepsakes, the
 * loading screen. One flat color: it's too small for the fold.
 */
export const LEAF_PATH_SMALL =
  "M0.46 -9.22L1.15 -7.92A0.29 0.29 0 0 0 1.51 -7.79L2.48 -8.18A0.39 0.39 0 0 1 3.01 -7.84Q3.07 -6.25 2.88 -4.67A0.48 0.48 0 0 0 3.73 -4.2L5.44 -5.8A0.48 0.48 0 0 1 6.19 -5.7L6.6 -5.02A0.29 0.29 0 0 0 6.91 -4.89L8.54 -5.31A0.57 0.57 0 0 1 9.19 -4.49L8.42 -3.04A0.31 0.31 0 0 0 8.46 -2.71L8.94 -2.1A0.44 0.44 0 0 1 8.88 -1.49Q7.21 -0.15 5.25 0.69A0.53 0.53 0 0 0 4.94 1.4L5.32 2.3A0.55 0.55 0 0 1 4.62 3.04L2.52 2.3A0.48 0.48 0 0 0 2.08 2.36L0.55 3.45C0.49 5.26 0.45 7.33 1.35 8.96A0.35 0.35 0 0 1 0.75 9.34C-0.36 7.64 -0.48 5.42 -0.55 3.45L-2.08 2.36A0.48 0.48 0 0 0 -2.52 2.3L-4.62 3.04A0.55 0.55 0 0 1 -5.32 2.3L-4.94 1.4A0.53 0.53 0 0 0 -5.25 0.69Q-7.21 -0.15 -8.88 -1.49A0.44 0.44 0 0 1 -8.94 -2.1L-8.46 -2.71A0.31 0.31 0 0 0 -8.42 -3.04L-9.19 -4.49A0.57 0.57 0 0 1 -8.54 -5.31L-6.91 -4.89A0.29 0.29 0 0 0 -6.6 -5.02L-6.19 -5.7A0.48 0.48 0 0 1 -5.44 -5.8L-3.73 -4.2A0.48 0.48 0 0 0 -2.88 -4.67Q-3.07 -6.25 -3.01 -7.84A0.39 0.39 0 0 1 -2.48 -8.18L-1.51 -7.79A0.29 0.29 0 0 0 -1.15 -7.92L-0.46 -9.22A0.53 0.53 0 0 1 0.46 -9.22Z";

/**
 * The autumn fill: amber at the top left down to maple red at the stem. The
 * gradient runs in the 100×100 box (userSpaceOnUse), so both halves share it.
 */
export const LEAF_GRADIENT = { x1: 24.7, y1: 7.35, x2: 71.1, y2: 94, offsets: [0, 0.55, 1] } as const;
export const LEAF_LIGHT = ["#F4A93E", "#D95B2D", "#AD3820"] as const;
export const LEAF_SHADE = ["#E2852F", "#C2472A", "#962F1D"] as const;

/** The colors around the leaf (the site's forest and cream, the app's night). */
export const BRAND = {
  /** The app icon's ground and the home page's hero. */
  forest: "#183A2B",
  /** The icon's soft light, high in the middle. */
  forestLit: "#2B5240",
  /** The icon's edges. */
  forestDeep: "#112A1F",
  /** Text on the forest. */
  cream: "#F5F1DF",
  /** The night look's ground and its amber. */
  night: "#0B0F0A",
  amber: "#E8A23F",
} as const;
