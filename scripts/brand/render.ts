/**
 * Redraws every icon file from Maple's mark (src/lib/brand.ts): the favicons,
 * the web app's icons and notification badge, the iPhone app's icon (light,
 * dark and tinted) and leaf, and Android's launcher layers and leaf.
 *
 *   pnpm brand:render
 *
 * sharp (librsvg) turns each SVG into PNG; favicon.ico holds 16, 32 and 48 px
 * PNGs. Placement, colors and the reasons for them: docs/brand.md.
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import sharp from "sharp";
import { BRAND, LEAF_GRADIENT, LEAF_LIGHT, LEAF_PATH, LEAF_SHADE, LEAF_SHADE_PATH, LEAF_VIEWBOX } from "@/lib/brand";

const ROOT = join(__dirname, "..", "..");

type Leaf = { light?: readonly string[]; shade?: readonly string[]; flat?: string };

function gradient(id: string, colors: readonly string[]): string {
  const { x1, y1, x2, y2, offsets } = LEAF_GRADIENT;
  const stops = colors.map((c, i) => `<stop offset="${offsets[i]}" stop-color="${c}"/>`).join("");
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`;
}

/** The leaf's defs and paths, in its 100×100 box. */
function leaf({ light = LEAF_LIGHT, shade = LEAF_SHADE, flat }: Leaf = {}): { defs: string; body: string } {
  if (flat) return { defs: "", body: `<path d="${LEAF_PATH}" fill="${flat}"/>` };
  return {
    defs: gradient("leaf", light) + gradient("leafShade", shade),
    body: `<path d="${LEAF_PATH}" fill="url(#leaf)"/><path d="${LEAF_SHADE_PATH}" fill="url(#leafShade)"/>`,
  };
}

const svg = (viewBox: string, inner: string, size?: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size ? ` width="${size}" height="${size}"` : ""}>${inner}</svg>`;

/** The bare leaf: favicons, the iPhone app's leaf, Android's offline screen, the badge. */
function mark(viewBox: string, look: Leaf = {}, size?: number): string {
  const { defs, body } = leaf(look);
  return svg(viewBox, (defs ? `<defs>${defs}</defs>` : "") + body, size);
}

type Ground = "forest" | "night" | "black" | "none";
const GROUNDS: Record<Exclude<Ground, "none">, [string, string, string]> = {
  // A soft light high in the middle, falling off to the edges: the home page's hero.
  forest: [BRAND.forestLit, BRAND.forest, BRAND.forestDeep],
  // The night look's near-black, lit the same way.
  night: ["#1B2419", "#0F150E", "#080B07"],
  black: ["#000000", "#000000", "#000000"],
};

/**
 * A square icon: a lit ground with the leaf at `scale`, nudged down by `dy` so
 * its body, not its stem, sits in the middle. `corner` rounds the square (the
 * web app's own icons); iOS and Android mask theirs.
 */
function icon({ size, ground, scale, dy, corner = 0, look = {} }: { size: number; ground: Ground; scale: number; dy: number; corner?: number; look?: Leaf }): string {
  const { defs, body } = leaf(look);
  const g = ground === "none" ? null : GROUNDS[ground];
  const groundDefs = g
    ? `<radialGradient id="ground" cx="0.5" cy="0.38" r="0.75"><stop offset="0" stop-color="${g[0]}"/><stop offset="0.6" stop-color="${g[1]}"/><stop offset="1" stop-color="${g[2]}"/></radialGradient>`
    : "";
  const clip = corner ? `<clipPath id="corner"><rect width="100" height="100" rx="${corner}"/></clipPath>` : "";
  const inner =
    `<defs>${defs}${groundDefs}${clip}</defs>` +
    `<g${corner ? ' clip-path="url(#corner)"' : ""}>` +
    (g ? `<rect width="100" height="100" fill="url(#ground)"/>` : "") +
    (scale > 0 ? `<g transform="translate(50 ${50 + dy}) scale(${scale}) translate(-50 -50)">${body}</g>` : "") +
    `</g>`;
  return svg("0 0 100 100", inner, size);
}

async function png(source: string, opaque = false): Promise<Buffer> {
  let img = sharp(Buffer.from(source));
  if (opaque) img = img.flatten({ background: "#000000" }).removeAlpha();
  return img.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

/** An .ico of PNG images (every browser since IE 11 reads them). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((m) => m.data)]);
}

const written: string[] = [];
function write(path: string, data: Buffer | string) {
  const file = join(ROOT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push(relative(ROOT, file));
}

// The leaf's place in each kind of icon (in the 100×100 square).
const APP = { scale: 0.74, dy: 2.4 }; // iOS, the Home Screen web app, the web app's own icons
const MASKABLE = { scale: 0.6, dy: 2 }; // inside Android's 80% safe circle
// Android's adaptive layers are 108 dp with 72 dp showing: the leaf takes the same share of what shows as on iOS.
const ADAPTIVE = { scale: APP.scale * (72 / 108), dy: APP.dy * (72 / 108) };
const TINTED: Leaf = { light: ["#FFFFFF", "#EDEDED", "#DCDCDC"], shade: ["#DCDCDC", "#C8C8C8", "#B4B4B4"] };

async function main() {
  // Web: the favicon (a bare leaf, cropped close) as SVG and ICO.
  write("public/maple-icon.svg", mark(LEAF_VIEWBOX) + "\n");
  const sizes = [16, 32, 48];
  write("public/favicon.ico", ico(await Promise.all(sizes.map(async (size) => ({ size, data: await png(mark(LEAF_VIEWBOX, {}, size)) })))));

  // Web app: rounded icons for browsers and desktops, a full square for iOS's Home Screen and Android's masks.
  for (const size of [192, 512]) write(`public/maple-icon-${size}.png`, await png(icon({ size, ground: "forest", ...APP, corner: 22 })));
  write("public/maple-icon-maskable-512.png", await png(icon({ size: 512, ground: "forest", ...MASKABLE }), true));
  write("public/maple-apple-touch-icon.png", await png(icon({ size: 180, ground: "forest", ...APP }), true));
  // Android's status bar badge for notifications: only its shape shows.
  write("public/maple-badge.png", await png(mark(LEAF_VIEWBOX, { flat: "#FFFFFF" }, 96)));

  // iPhone app: light, dark and tinted icons, and the leaf the offline screen shows.
  const ios = "ios/Maple/Assets.xcassets";
  write(`${ios}/AppIcon.appiconset/AppIcon-1024.png`, await png(icon({ size: 1024, ground: "forest", ...APP }), true));
  write(`${ios}/AppIcon.appiconset/AppIcon-1024-dark.png`, await png(icon({ size: 1024, ground: "night", ...APP }), true));
  write(`${ios}/AppIcon.appiconset/AppIcon-1024-tinted.png`, await png(icon({ size: 1024, ground: "black", ...APP, look: TINTED }), true));
  const appearance = (value: string) => ({ appearances: [{ appearance: "luminosity", value }] });
  const iconSet = {
    images: [
      { filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      { ...appearance("dark"), filename: "AppIcon-1024-dark.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      { ...appearance("tinted"), filename: "AppIcon-1024-tinted.png", idiom: "universal", platform: "ios", size: "1024x1024" },
    ],
    info: { author: "xcode", version: 1 },
  };
  // Spaced the way Xcode writes it ("key" : value), so opening the project leaves the file alone.
  write(`${ios}/AppIcon.appiconset/Contents.json`, JSON.stringify(iconSet, null, 2).replace(/"([^"]+)": /g, '"$1" : ') + "\n");
  write(`${ios}/MapleMark.imageset/maple-mark.svg`, mark("0 0 100 100", {}, 100) + "\n");

  // Android: adaptive icon layers per density (108 dp each), the themed-icon shape, and the offline screen's leaf.
  const densities: [string, number][] = [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]];
  for (const [name, k] of densities) {
    const size = Math.round(108 * k);
    const dir = `android/app/src/main/res/mipmap-${name}`;
    // scale 0: the ground alone, without the leaf.
    write(`${dir}/ic_launcher_background.png`, await png(icon({ size, ground: "forest", scale: 0, dy: 0 }), true));
    write(`${dir}/ic_launcher_foreground.png`, await png(icon({ size, ground: "none", ...ADAPTIVE })));
    write(`${dir}/ic_launcher_monochrome.png`, await png(icon({ size, ground: "none", ...ADAPTIVE, look: { flat: "#FFFFFF" } })));
  }
  write("android/app/src/main/res/drawable-nodpi/maple_leaf.png", await png(mark("0 0 100 100", {}, 360)));

  console.log(`Wrote ${written.length} files:\n  ${written.join("\n  ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
