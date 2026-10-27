import { ImageResponse } from "next/og";
import { OgLeaf, ogFonts } from "@/components/site/og";

export const alt = "Maple. Left boob or right boob? Beside it, a night clock reads 3:12 am.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const HEADLINE = "Left boob or right boob?";

export default async function OpenGraphImage() {
  const fonts = await ogFonts(`Maple${HEADLINE}`, "3:12 am");
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#F6F3EC", fontFamily: "Cormorant" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 760, padding: "64px 72px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <OgLeaf />
            <span style={{ fontSize: 52, fontWeight: 600, color: "#1C2619" }}>Maple</span>
          </div>
          <div style={{ display: "flex", fontSize: 112, fontWeight: 600, lineHeight: 1, color: "#1C2619", letterSpacing: "-0.01em" }}>
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
