import { ImageResponse } from "next/og";
import { OgLeaf, ogFonts } from "@/components/site/og";

export const alt = "The story behind Maple. A clearer picture of our baby's feeds.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const HEADLINE = "The story behind Maple.";
const CAPTION = "A clearer picture of our baby’s feeds.";

export default async function AboutImage() {
  const fonts = await ogFonts(`Maple${HEADLINE}`, CAPTION);
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#F6F3EC", fontFamily: "Cormorant" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 760, padding: "64px 72px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <OgLeaf />
            <span style={{ fontSize: 52, fontWeight: 600, color: "#1C2619" }}>Maple</span>
          </div>
          <div style={{ display: "flex", fontSize: 104, fontWeight: 600, lineHeight: 1.02, color: "#1C2619", letterSpacing: "-0.01em" }}>
            {HEADLINE}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            flex: 1,
            padding: "64px 48px",
            background: "#0B0F0A",
            color: "#E8A23F",
            fontStyle: "italic",
            fontWeight: 500,
            fontSize: 58,
            lineHeight: 1.12,
          }}
        >
          {CAPTION}
        </div>
      </div>
    ),
    { ...size, fonts }
  );
}
