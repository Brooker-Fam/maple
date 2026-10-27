import { postInstant, publishedPosts } from "@/lib/blog";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";

export const dynamic = "force-static";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const absolute = (html: string) => html.replace(/(href|src)="\/(?!\/)/g, `$1="${MAPLE_ORIGIN}/`);

export function GET() {
  const posts = publishedPosts();
  const feed = `${MAPLE_ORIGIN}/blog/feed.xml`;
  const items = posts
    .map((p) => {
      const link = `${MAPLE_ORIGIN}/blog/${p.slug}`;
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${postInstant(p.date).toUTCString()}</pubDate>
      <dc:creator>${esc(p.author)}</dc:creator>
      <description>${esc(p.description)}</description>
      <content:encoded>${cdata(absolute(p.html))}</content:encoded>
    </item>`;
    })
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Maple blog</title>
    <link>${MAPLE_ORIGIN}/blog</link>
    <atom:link href="${feed}" rel="self" type="application/rss+xml" />
    <description>Posts about how Maple, a newborn tracker, works.</description>
    <language>en-us</language>
${posts[0] ? `    <lastBuildDate>${postInstant(posts[0].date).toUTCString()}</lastBuildDate>\n` : ""}${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
