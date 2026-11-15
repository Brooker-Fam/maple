import { LEAF_GRADIENT, LEAF_LIGHT, LEAF_PATH, LEAF_SHADE, LEAF_SHADE_PATH, LEAF_VIEWBOX } from "@/lib/brand";

/** Maple's leaf (src/lib/brand.ts), cropped close, for the social cards. */
export function OgLeaf({ size = 56 }: { size?: number }) {
  const { x1, y1, x2, y2, offsets } = LEAF_GRADIENT;
  const fill = (id: string, colors: readonly string[]) => (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
      {colors.map((c, i) => (
        <stop key={c} offset={offsets[i]} stopColor={c} />
      ))}
    </linearGradient>
  );
  return (
    <svg width={size} height={size} viewBox={LEAF_VIEWBOX}>
      <defs>
        {fill("leaf", LEAF_LIGHT)}
        {fill("leafShade", LEAF_SHADE)}
      </defs>
      <path d={LEAF_PATH} fill="url(#leaf)" />
      <path d={LEAF_SHADE_PATH} fill="url(#leafShade)" />
    </svg>
  );
}

/** Cut down to the card's own letters; the default face stands in when the fetch fails. */
async function cormorant(weight: number, italic: boolean, text: string): Promise<ArrayBuffer | null> {
  try {
    const family = `Cormorant+Garamond:${italic ? "ital," : ""}wght@${italic ? "1," : ""}${weight}`;
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(text)}`).then((r) => r.text());
    const src = /src: url\((.+?)\) format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
    return src ? await fetch(src).then((r) => r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function ogFonts(displayText: string, italicText: string) {
  const [display, italic] = await Promise.all([cormorant(600, false, displayText), cormorant(500, true, italicText)]);
  return [
    ...(display ? [{ name: "Cormorant", data: display, weight: 600 as const, style: "normal" as const }] : []),
    ...(italic ? [{ name: "Cormorant", data: italic, weight: 500 as const, style: "italic" as const }] : []),
  ];
}
