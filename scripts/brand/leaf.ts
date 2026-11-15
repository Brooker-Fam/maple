/**
 * How Maple's leaf is drawn: the right half as points with corner radii, a
 * curved stem, then mirrored down the midrib. Prints the paths for
 * src/lib/brand.ts, or puts them there:
 *
 *   pnpm brand:leaf            print the constants
 *   pnpm brand:leaf --write    rewrite them in src/lib/brand.ts
 *
 * Then `pnpm brand:render` redraws the icon files. Every corner is an exact
 * arc (a radius, so the points stay soft at 1024 px and crisp at 16 px); an
 * edge with `bow` swells outward as one quadratic curve; the stem's two edges
 * are cubics fitted to a tapered offset of its centerline.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

type Pt = [number, number];
type Vert = { p: Pt; r: number; bow?: number; cubic?: [Pt, Pt]; cap?: boolean };

/** The right half, top to bottom, in the 100×100 box. */
const RIGHT: Vert[] = [
  { p: [50, 4.6], r: 2.4 }, // the tip
  { p: [55.8, 15.6], r: 1.3 }, // notch
  { p: [63.6, 12.4], r: 1.8, bow: 0.8 }, // the top lobe's shoulder; its side swells a little
  { p: [62.0, 36.2], r: 2.2 }, // sinus
  { p: [76.8, 22.4], r: 2.2 }, // side lobe: upper point
  { p: [80.6, 28.6], r: 1.3 }, // notch
  { p: [94.6, 25.0], r: 2.6 }, // side lobe: tip
  { p: [88.0, 37.6], r: 1.4 }, // notch
  { p: [92.0, 42.6], r: 2.0, bow: 1.0 }, // side lobe: lower point; the edge below swells
  { p: [71.6, 54.8], r: 2.4 }, // sinus
  { p: [76.4, 66.4], r: 2.6 }, // bottom lobe
  { p: [60.4, 60.8], r: 2.2 }, // notch, then the stem
];
/** The stem's centerline (a cubic, curving right) and its width at each end. */
const STEM = { from: [50, 66.4] as Pt, c1: [50, 76] as Pt, c2: [50.8, 86] as Pt, to: [54.8, 92.4] as Pt, w0: 5.0, w1: 3.2 };
/** The small leaf's height, centered on 0,0. */
const SMALL_HEIGHT = 19;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const norm = (a: Pt) => mul(a, 1 / len(a));
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const quad = (p0: Pt, c: Pt, p2: Pt, t: number): Pt => add(add(mul(p0, (1 - t) ** 2), mul(c, 2 * (1 - t) * t)), mul(p2, t * t));
const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt =>
  [0, 1].map((k) => (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * p1[k] + 3 * (1 - t) * t * t * p2[k] + t ** 3 * p3[k]) as Pt;
const cubicD = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt =>
  [0, 1].map((k) => 3 * (1 - t) ** 2 * (p1[k] - p0[k]) + 6 * (1 - t) * t * (p2[k] - p1[k]) + 3 * t * t * (p3[k] - p2[k])) as Pt;
const num = (n: number) => {
  const s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};
const pt = (p: Pt) => `${num(p[0])} ${num(p[1])}`;

/** Arc length along a quadratic, from either end, to find where a corner's cut lands on it. */
function quadParamAt(p0: Pt, c: Pt, p2: Pt, dist: number, fromEnd: boolean): number {
  let acc = 0;
  let prev = fromEnd ? p2 : p0;
  for (let i = 1; i <= 256; i++) {
    const t = fromEnd ? 1 - i / 256 : i / 256;
    const q = quad(p0, c, p2, t);
    acc += len(sub(q, prev));
    prev = q;
    if (acc >= dist) return t;
  }
  return fromEnd ? 0 : 1;
}
const quadLength = (p0: Pt, c: Pt, p2: Pt) => {
  let L = 0;
  for (let i = 1; i <= 64; i++) L += len(sub(quad(p0, c, p2, i / 64), quad(p0, c, p2, (i - 1) / 64)));
  return L;
};

/** One cubic through points sampled along a curve (least squares, ends and their directions fixed). */
function fitCubic(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  const p0 = pts[0], p3 = pts[pts.length - 1];
  const t0 = norm(sub(pts[1], p0)), t3 = norm(sub(pts[pts.length - 2], p3));
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + len(sub(pts[i], pts[i - 1])));
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  pts.forEach((p, i) => {
    const t = d[i] / d[d.length - 1];
    const b0 = (1 - t) ** 3, b1 = 3 * (1 - t) ** 2 * t, b2 = 3 * (1 - t) * t * t, b3 = t ** 3;
    const a1 = mul(t0, b1), a2 = mul(t3, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const rest = sub(p, add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, rest);
    x1 += dot(a2, rest);
  });
  const det = c00 * c11 - c01 * c01;
  return [p0, add(p0, mul(t0, (x0 * c11 - x1 * c01) / det)), add(p3, mul(t3, (c00 * x1 - c01 * x0) / det)), p3];
}

/** The stem as four outline points: down its right edge, round the end, up its left edge. */
function stemVerts(): Vert[] {
  const right: Pt[] = [], left: Pt[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const p = cubic(STEM.from, STEM.c1, STEM.c2, STEM.to, t);
    const dd = cubicD(STEM.from, STEM.c1, STEM.c2, STEM.to, t);
    const n: Pt = [dd[1] / len(dd), -dd[0] / len(dd)];
    const w = (STEM.w0 + (STEM.w1 - STEM.w0) * t) / 2;
    right.push(add(p, mul(n, w)));
    left.push(sub(p, mul(n, w)));
  }
  const R = fitCubic(right), L = fitCubic(left.reverse());
  return [
    { p: R[0], r: 0, cubic: [R[1], R[2]] },
    { p: R[3], r: 0, cap: true },
    { p: L[0], r: 0, cubic: [L[1], L[2]] },
    { p: L[3], r: 0 },
  ];
}

/** The left half: the right half mirrored, bottom to top (each bow moves to the edge's new starting point). */
function mirrored(right: Vert[]): Vert[] {
  const out: Vert[] = [];
  for (let j = right.length - 1; j >= 1; j--) out.push({ p: [100 - right[j].p[0], right[j].p[1]], r: right[j].r, bow: right[j - 1].bow });
  return out;
}

type Edge =
  | { kind: "L"; a: Pt; b: Pt; L: number }
  | { kind: "Q"; a: Pt; b: Pt; c: Pt; L: number }
  | { kind: "C"; a: Pt; b: Pt; c1: Pt; c2: Pt }
  | { kind: "S"; a: Pt; b: Pt; r: number };
type Corner = { r: number; A: Pt; B: Pt; tin: number; tout: number; sweep: 0 | 1; center: Pt };

/** The closed outline: each segment as SVG, plus points along it for the bounds. */
function outline(verts: Vert[]) {
  const n = verts.length;
  const edges: Edge[] = verts.map((v, i) => {
    const a = v.p, b = verts[(i + 1) % n].p;
    if (v.cubic) return { kind: "C", a, b, c1: v.cubic[0], c2: v.cubic[1] };
    if (v.cap) return { kind: "S", a, b, r: len(sub(b, a)) / 2 };
    if (v.bow) {
      const m = lerp(a, b, 0.5), L = len(sub(b, a));
      const c: Pt = [m[0] + ((b[1] - a[1]) / L) * v.bow * 2, m[1] - ((b[0] - a[0]) / L) * v.bow * 2];
      return { kind: "Q", a, b, c, L: quadLength(a, c, b) };
    }
    return { kind: "L", a, b, L: len(sub(b, a)) };
  });
  const startDir = (e: Edge) => norm(e.kind === "Q" ? sub(e.c, e.a) : e.kind === "C" ? sub(e.c1, e.a) : sub(e.b, e.a));
  const endDir = (e: Edge) => norm(e.kind === "Q" ? sub(e.b, e.c) : e.kind === "C" ? sub(e.b, e.c2) : sub(e.b, e.a));
  const corners: Corner[] = verts.map((v, i) => {
    const ein = edges[(i - 1 + n) % n], eout = edges[i];
    const flat: Corner = { r: 0, A: v.p, B: v.p, tin: 1, tout: 0, sweep: 0, center: v.p };
    if (!v.r || ein.kind === "C" || ein.kind === "S" || eout.kind === "C" || eout.kind === "S") return flat;
    const u1 = mul(endDir(ein), -1), u2 = startDir(eout);
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
    let d = v.r / Math.tan(theta / 2), r = v.r;
    const most = Math.min(ein.L, eout.L) * 0.45;
    if (d > most) [d, r] = [most, most * Math.tan(theta / 2)];
    const tin = ein.kind === "Q" ? quadParamAt(ein.a, ein.c, ein.b, d, true) : 1 - d / ein.L;
    const tout = eout.kind === "Q" ? quadParamAt(eout.a, eout.c, eout.b, d, false) : d / eout.L;
    const A = ein.kind === "Q" ? quad(ein.a, ein.c, ein.b, tin) : lerp(ein.a, ein.b, tin);
    const B = eout.kind === "Q" ? quad(eout.a, eout.c, eout.b, tout) : lerp(eout.a, eout.b, tout);
    const center = add(v.p, mul(norm(add(u1, u2)), r / Math.sin(theta / 2)));
    return { r, A, B, tin, tout, sweep: cross(mul(u1, -1), u2) > 0 ? 1 : 0, center };
  });
  const segs: { kind: Edge["kind"]; svg: string; edge: Edge }[] = [];
  const samples: Pt[] = [];
  const arcSamples = (c: Corner) => {
    const a0 = Math.atan2(c.A[1] - c.center[1], c.A[0] - c.center[0]);
    let a1 = Math.atan2(c.B[1] - c.center[1], c.B[0] - c.center[0]);
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    const at = (a: number): Pt => [c.center[0] + c.r * Math.cos(a), c.center[1] + c.r * Math.sin(a)];
    samples.push(at(a0), at(a1));
    // The arc's own extremes, where it passes due left, right, up or down.
    for (let q = -2; q <= 2; q++) {
      const a = (q * Math.PI) / 2;
      for (const turn of [a, a + 2 * Math.PI, a - 2 * Math.PI]) if ((turn - a0) * (turn - a1) <= 0) samples.push(at(turn));
    }
  };
  for (let i = 0; i < n; i++) {
    const e = edges[i], c0 = corners[i], c1 = corners[(i + 1) % n];
    let svg = "";
    if (e.kind === "L") svg = `L${pt(c1.A)}`;
    else if (e.kind === "Q") {
      // The part of the curve between the two corners' cuts (its control point by blossoming).
      const ctrl = add(add(mul(e.a, (1 - c0.tout) * (1 - c1.tin)), mul(e.c, (1 - c0.tout) * c1.tin + c0.tout * (1 - c1.tin))), mul(e.b, c0.tout * c1.tin));
      svg = `Q${pt(ctrl)} ${pt(c1.A)}`;
      for (let k = 0; k <= 256; k++) samples.push(quad(e.a, e.c, e.b, c0.tout + ((c1.tin - c0.tout) * k) / 256));
    } else if (e.kind === "C") {
      svg = `C${pt(e.c1)} ${pt(e.c2)} ${pt(e.b)}`;
      for (let k = 0; k <= 256; k++) samples.push(cubic(e.a, e.c1, e.c2, e.b, k / 256));
    } else {
      svg = `A${num(e.r)} ${num(e.r)} 0 0 1 ${pt(e.b)}`;
      const m = lerp(e.a, e.b, 0.5), a0 = Math.atan2(e.a[1] - m[1], e.a[0] - m[0]);
      for (let k = 0; k <= 32; k++) samples.push([m[0] + e.r * Math.cos(a0 + (Math.PI * k) / 32), m[1] + e.r * Math.sin(a0 + (Math.PI * k) / 32)]);
    }
    samples.push(c1.A);
    if (c1.r > 0) {
      svg += `A${num(c1.r)} ${num(c1.r)} 0 0 ${c1.sweep} ${pt(c1.B)}`;
      arcSamples(c1);
    }
    segs.push({ kind: e.kind, svg, edge: e });
  }
  return { d: `M${pt(corners[0].B)}${segs.map((s) => s.svg).join("")}Z`, segs, corners, samples };
}

/** The half right of the midrib: the right outline, the stem's left edge cut where it crosses x = 50, then up the midrib. */
function shadeHalf(o: ReturnType<typeof outline>): string {
  const top = o.corners[0];
  const apex: Pt = [50, top.center[1] - top.r];
  let d = `M${pt(apex)}A${num(top.r)} ${num(top.r)} 0 0 1 ${pt(top.B)}`;
  let k = 0;
  for (; k < o.segs.length; k++) {
    d += o.segs[k].svg;
    if (o.segs[k].kind === "S") break;
  }
  const e = o.segs[k + 1].edge;
  if (e.kind !== "C") throw new Error("expected the stem's left edge after its end");
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cubic(e.a, e.c1, e.c2, e.b, mid)[0] > 50) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  const p01 = lerp(e.a, e.c1, t), p12 = lerp(e.c1, e.c2, t), p23 = lerp(e.c2, e.b, t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), cut = lerp(p012, p123, t);
  return `${d}C${pt(p01)} ${pt(p012)} ${pt([50, cut[1]])}L${pt(apex)}Z`;
}

/** A path scaled by s and moved by (tx, ty); radii scale with it. */
function moved(d: string, s: number, tx: number, ty: number): string {
  const tok = d.match(/[MLQCAZ]|-?\d*\.?\d+/g) ?? [];
  let i = 0, out = "";
  const next = () => parseFloat(tok[i++]);
  const p = () => {
    const x = next(), y = next();
    return pt([x * s + tx, y * s + ty]);
  };
  while (i < tok.length) {
    const c = tok[i++];
    if (c === "Z") out += "Z";
    else if (c === "M" || c === "L") out += c + p();
    else if (c === "Q") out += `Q${p()} ${p()}`;
    else if (c === "C") out += `C${p()} ${p()} ${p()}`;
    else if (c === "A") {
      const rx = next(), ry = next(), rot = next(), large = next(), sweep = next();
      out += `A${num(rx * s)} ${num(ry * s)} ${rot} ${large} ${sweep} ${p()}`;
    }
  }
  return out;
}

const o = outline([...RIGHT, ...stemVerts(), ...mirrored(RIGHT)]);
const xs = o.samples.map((q) => q[0]), ys = o.samples.map((q) => q[1]);
const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
const bounds = { x: +box.x.toFixed(2), y: +box.y.toFixed(2), width: +box.width.toFixed(2), height: +box.height.toFixed(2) };
const s = SMALL_HEIGHT / bounds.height;
const consts: Record<string, string> = {
  LEAF_PATH: o.d,
  LEAF_SHADE_PATH: shadeHalf(o),
  LEAF_PATH_SMALL: moved(o.d, s, -50 * s, -(bounds.y + bounds.height / 2) * s),
};

if (process.argv.includes("--write")) {
  const file = join(__dirname, "..", "..", "src", "lib", "brand.ts");
  let src = readFileSync(file, "utf8");
  for (const [name, d] of Object.entries(consts)) {
    const re = new RegExp(`(export const ${name} =\\n  )"[^"]*";`);
    if (!re.test(src)) throw new Error(`${name} not found in brand.ts`);
    src = src.replace(re, `$1"${d}";`);
  }
  src = src.replace(/export const LEAF_BOUNDS = \{[^}]*\} as const;/, `export const LEAF_BOUNDS = { x: ${bounds.x}, y: ${bounds.y}, width: ${bounds.width}, height: ${bounds.height} } as const;`);
  writeFileSync(file, src);
  console.log("Updated src/lib/brand.ts. Now run pnpm brand:render.");
} else {
  for (const [name, d] of Object.entries(consts)) console.log(`export const ${name} =\n  "${d}";\n`);
  console.log(`export const LEAF_BOUNDS = ${JSON.stringify(bounds)} as const;`);
}
