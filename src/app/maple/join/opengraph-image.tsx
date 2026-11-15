import { ImageResponse } from "next/og";
import { OgLeaf, ogFonts } from "@/components/site/og";

// The preview a messaging app shows for an invite link. The same card for every
// invite: the key is after the #, so nothing here can know whose family it is.
export const alt = "An invitation to Maple's Log, a family's private newborn log.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Not "You’re invited": the card renderer measures "Yo" unkerned and draws it kerned, leaving a gap after the word.
const LEAD = "An invitation to";
const NAME = "Maple’s Log.";
const LINE = "A family’s private newborn log.";

export default async function InviteImage() {
  const fonts = await ogFonts(`${LEAD}${LINE}`, NAME);
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          gap: 56,
          padding: "0 80px 0 96px",
          backgroundColor: "#153328",
          backgroundImage: "radial-gradient(circle at 25% 50%, #36513F 0%, #1C3C2F 24%, #153328 46%)",
          color: "#F5F1DF",
          fontFamily: "Cormorant",
        }}
      >
        <OgLeaf size={300} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 44, fontWeight: 600, color: "#CAD6C0" }}>{LEAD}</span>
          <span style={{ fontSize: 112, lineHeight: 1.02, fontStyle: "italic", fontWeight: 500, color: "#DCDEA7", letterSpacing: "-0.02em" }}>{NAME}</span>
          <span style={{ marginTop: 18, fontSize: 36, fontWeight: 600, color: "#CAD6C0" }}>{LINE}</span>
        </div>
      </div>
    ),
    { ...size, fonts }
  );
}
