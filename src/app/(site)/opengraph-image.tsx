import { ImageResponse } from "next/og";
import { OgLeaf, ogFonts } from "@/components/site/og";

export const alt = "Maple Baby. Make sense of the early days. Feeds, sleep, diapers, growth and firsts, together.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The home page's day dial, drawn again: ticks every half hour, sleep and feeds as arcs, diapers as dots.
const TICKS = Array.from({ length: 48 }, (_, i) => i * 7.5);

export default async function OpenGraphImage() {
  // Every line is set at a weight the card loads (600, or the italic's 500): a line between them borrows letters from both.
  const fonts = await ogFonts("Maple BabyMake senseof theFeeds · Sleep · Diapers · Growth · FirstsIt all belongs.", "early days.");
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: "#153328",
          backgroundImage: "radial-gradient(circle at 78% 50%, #36513F 0%, #1C3C2F 30%, #153328 52%)",
          color: "#F5F1DF",
          fontFamily: "Cormorant",
          padding: "52px 64px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 620 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <OgLeaf size={54} />
            <span style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.01em" }}>Maple Baby</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 88, lineHeight: 0.98, fontWeight: 600, letterSpacing: "-0.02em" }}>
            <span>Make sense</span>
            <span>of the</span>
            <span style={{ fontStyle: "italic", fontWeight: 500, color: "#DCDEA7" }}>early days.</span>
          </div>
          <div style={{ display: "flex", fontSize: 27, fontWeight: 600, color: "#CAD6C0", letterSpacing: "0.01em" }}>Feeds · Sleep · Diapers · Growth · Firsts</div>
        </div>
        <div style={{ position: "relative", display: "flex", width: 430, alignItems: "center", justifyContent: "center" }}>
          <svg width="410" height="410" viewBox="0 0 400 400">
            <circle cx="200" cy="200" r="194" fill="none" stroke="#718770" strokeWidth="1" strokeOpacity="0.7" />
            <circle cx="200" cy="200" r="173" fill="#2B4636" stroke="#718770" strokeWidth="1" />
            {TICKS.map((a, i) => (
              <line key={a} x1="200" y1={i % 4 ? 33 : 30} x2="200" y2="40" stroke="#DFE9D1" strokeWidth={i % 4 ? 1 : 2} strokeOpacity={i % 4 ? 0.22 : 0.5} transform={`rotate(${a} 200 200)`} />
            ))}
            <g fill="none" strokeWidth="20" strokeLinecap="round" transform="rotate(-100 200 200)">
              <circle cx="200" cy="200" r="145" stroke="#B9A6D4" strokeDasharray="114 797" strokeDashoffset="-11" />
              <circle cx="200" cy="200" r="145" stroke="#B9A6D4" strokeDasharray="86 825" strokeDashoffset="-230" />
              <circle cx="200" cy="200" r="145" stroke="#B9A6D4" strokeDasharray="140 771" strokeDashoffset="-520" />
              <circle cx="200" cy="200" r="117" stroke="#EEB285" strokeDasharray="28 707" strokeDashoffset="-115" />
              <circle cx="200" cy="200" r="117" stroke="#EEB285" strokeDasharray="28 707" strokeDashoffset="-375" />
              <circle cx="200" cy="200" r="117" stroke="#EEB285" strokeDasharray="28 707" strokeDashoffset="-632" />
            </g>
            {/* turned with the arcs (the page's dial turns them -90°, this one -100°) */}
            <g fill="#ADD1CF" transform="rotate(-10 200 200)">
              <circle cx="293" cy="103" r="6" />
              <circle cx="315" cy="249" r="6" />
              <circle cx="144" cy="322" r="6" />
              <circle cx="95" cy="183" r="6" />
            </g>
            <circle cx="200" cy="200" r="91" fill="#E9EDCF" />
          </svg>
          <div style={{ position: "absolute", left: 125, top: 173, width: 180, height: 180, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <OgLeaf size={34} />
            <div style={{ display: "flex", marginTop: 6, width: 150, textAlign: "center", justifyContent: "center", fontSize: 44, lineHeight: 0.95, fontWeight: 600, color: "#193729", letterSpacing: "-0.02em" }}>
              It all belongs.
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts }
  );
}
