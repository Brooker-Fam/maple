import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { OgLeaf, ogFonts } from "@/components/site/og";
import { findPost, pagePosts } from "@/lib/blog";

const size = { width: 1200, height: 630 };
const contentType = "image/png";

type Params = { slug: string };

export function generateStaticParams() {
  return pagePosts().map((p) => ({ slug: p.slug }));
}

export async function generateImageMetadata({ params }: { params: Params | Promise<Params> }) {
  const post = findPost((await params).slug);
  return [{ id: "card", alt: post ? `${post.title}, a post on Maple's blog` : "A post on Maple's blog", size, contentType }];
}

export default async function PostImage({ params }: { params: Promise<Params> }) {
  const post = findPost((await params).slug);
  if (!post) notFound();
  const when = new Date(`${post.date}T00:00:00Z`);
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(when);
  const year = String(when.getUTCFullYear());
  const titleSize = post.title.length > 34 ? 68 : 80;
  const fonts = await ogFonts(`MapleBlog${post.title}`, `${day}${year}`);
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#F6F3EC", fontFamily: "Cormorant" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 820, padding: "64px 72px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <OgLeaf />
            <span style={{ fontSize: 52, fontWeight: 600, color: "#1C2619" }}>Maple</span>
            <span style={{ fontSize: 52, fontWeight: 600, color: "#7A8274", marginLeft: 6 }}>Blog</span>
          </div>
          <div style={{ display: "flex", fontSize: titleSize, fontWeight: 600, lineHeight: 1.04, color: "#1C2619", letterSpacing: "-0.01em" }}>
            {post.title}
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
          }}
        >
          <span style={{ fontSize: 96, lineHeight: 1 }}>{day}</span>
          <span style={{ fontSize: 44, marginTop: 10, opacity: 0.7 }}>{year}</span>
        </div>
      </div>
    ),
    { ...size, fonts }
  );
}
