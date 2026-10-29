import { ImageResponse } from "next/og";
import { OgLeaf, ogFonts } from "@/components/site/og";

export const alt = "Maple Baby. Make sense of the early days. Feeds, sleep, diapers, growth and firsts, together.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const fonts = await ogFonts("Maple BabyMake senseof theFeeds · Sleep · Diapers · Growth · FirstsIt all belongs.", "early days.");
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#153328", color: "#F5F1DF", fontFamily: "Cormorant", padding: "52px 64px" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 620 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}><OgLeaf /><span style={{ fontSize: 42, fontWeight: 600 }}>Maple Baby</span></div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 88, lineHeight: .98, fontWeight: 600, letterSpacing: "-.02em" }}>
            <span>Make sense</span><span>of the</span><span style={{ fontStyle: "italic", fontWeight: 500, color: "#DCDEA7" }}>early days.</span>
          </div>
          <div style={{ display: "flex", fontSize: 26, color: "#CAD6C0" }}>Feeds · Sleep · Diapers · Growth · Firsts</div>
        </div>
        <div style={{ position: "relative", display: "flex", width: 430, alignItems: "center", justifyContent: "center" }}>
          <svg width="410" height="410" viewBox="0 0 400 400">
            <circle cx="200" cy="200" r="194" fill="none" stroke="#718770" strokeWidth="1" />
            <circle cx="200" cy="200" r="173" fill="#2B4636" stroke="#718770" strokeWidth="1" />
            <g fill="none" strokeWidth="20" strokeLinecap="round" transform="rotate(-100 200 200)">
              <circle cx="200" cy="200" r="145" stroke="#B9A6D4" strokeDasharray="114 797" strokeDashoffset="-11" />
              <circle cx="200" cy="200" r="145" stroke="#B9A6D4" strokeDasharray="86 825" strokeDashoffset="-230" />
              <circle cx="200" cy="200" r="145" stroke="#B9A6D4" strokeDasharray="140 771" strokeDashoffset="-520" />
              <circle cx="200" cy="200" r="117" stroke="#EEB285" strokeDasharray="28 707" strokeDashoffset="-115" />
              <circle cx="200" cy="200" r="117" stroke="#EEB285" strokeDasharray="28 707" strokeDashoffset="-375" />
              <circle cx="200" cy="200" r="117" stroke="#EEB285" strokeDasharray="28 707" strokeDashoffset="-632" />
            </g>
            <circle cx="200" cy="200" r="91" fill="#E9EDCF" />
          </svg>
          <div style={{ position: "absolute", top: 201, left: 133, width: 165, display: "flex", textAlign: "center", fontSize: 47, lineHeight: .95, fontWeight: 600, color: "#193729" }}>It all belongs.</div>
        </div>
      </div>
    ),
    { ...size, fonts }
  );
}
