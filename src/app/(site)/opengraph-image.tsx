import { ImageResponse } from "next/og";

export const alt = "Maple: the newborn log for both of you, built for 3am";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const HEADLINE = "The newborn log for both of you, built for 3am.";
const LEAF =
  "M50 4 L55.5 15.5 L62.5 11.5 L60.5 28 Q61.5 36.5 69.5 32.5 L77 22.5 L81 28 L95 24.5 L88.5 37.5 L94 42 L80.5 50.5 Q75 58.5 67.5 55.5 L72 64 L60 61.5 L53.6 66 L51.7 67.5 L52.9 86 L47.1 86 L48.3 67.5 L46.4 66 L40 61.5 L28 64 L32.5 55.5 Q25 58.5 19.5 50.5 L6 42 L11.5 37.5 L5 24.5 L19 28 L23 22.5 L30.5 32.5 Q38.5 36.5 39.5 28 L37.5 11.5 L44.5 15.5 L50 4 Z";

/** Cormorant Garamond cut down to the card's own letters; the default face stands in when the fetch fails. */
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

export default async function OpenGraphImage() {
  const [display, italic] = await Promise.all([cormorant(600, false, `Maple${HEADLINE}`), cormorant(500, true, "3:12 am")]);
  const fonts = [
    ...(display ? [{ name: "Cormorant", data: display, weight: 600 as const, style: "normal" as const }] : []),
    ...(italic ? [{ name: "Cormorant", data: italic, weight: 500 as const, style: "italic" as const }] : []),
  ];
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#F6F3EC", fontFamily: "Cormorant" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 760, padding: "64px 72px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width="54" height="50" viewBox="0 0 100 92">
              <defs>
                <linearGradient id="g" x1="0.2" y1="0" x2="0.75" y2="1">
                  <stop offset="0" stopColor="#E8902F" />
                  <stop offset="0.55" stopColor="#CC4A2A" />
                  <stop offset="1" stopColor="#A3321F" />
                </linearGradient>
              </defs>
              <path d={LEAF} fill="url(#g)" />
            </svg>
            <span style={{ fontSize: 52, fontWeight: 600, color: "#1C2619" }}>Maple</span>
          </div>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 600, lineHeight: 1.02, color: "#1C2619", letterSpacing: "-0.01em" }}>
            {HEADLINE}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            flex: 1,
            padding: "64px 56px",
            background: "#0B0F0A",
            color: "#E8A23F",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", fontStyle: "italic", fontWeight: 500 }}>
            <span style={{ fontSize: 132, lineHeight: 1 }}>3:12</span>
            <span style={{ fontSize: 52, marginLeft: 12, opacity: 0.7 }}>am</span>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts }
  );
}
