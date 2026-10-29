import { ImageResponse } from "next/og";
import { OgLeaf, ogFonts } from "@/components/site/og";

export const alt = "Maple Baby. See the patterns in your baby’s feeding. Feeds, diapers, and growth in one shared log.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const HEADLINE = "See the patterns in your baby’s feeding.";
const SUPPORT = "Feeds · Diapers · Growth";

export default async function OpenGraphImage() {
  const fonts = await ogFonts(`Maple Baby${HEADLINE}${SUPPORT}`, "A clearer picture.");
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#F6F3EC", fontFamily: "Cormorant" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 830, padding: "56px 64px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <OgLeaf />
            <span style={{ fontSize: 48, fontWeight: 600, color: "#1C2619" }}>Maple Baby</span>
          </div>
          <div style={{ display: "flex", fontSize: 88, fontWeight: 600, lineHeight: 1, color: "#1C2619", letterSpacing: "-0.01em" }}>{HEADLINE}</div>
          <div style={{ display: "flex", fontSize: 32, fontWeight: 600, color: "#53634D" }}>{SUPPORT}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flex: 1, padding: "56px 40px", background: "#1D4420", color: "#F6F3EC" }}>
          <div style={{ display: "flex", fontSize: 66, lineHeight: 1.05, fontStyle: "italic", fontWeight: 500 }}>A clearer picture.</div>
        </div>
      </div>
    ),
    { ...size, fonts }
  );
}
