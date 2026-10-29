import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { siteOpenGraph } from "@/components/site/meta";
import { type Post, postDateText, publishedPosts } from "@/lib/blog";

const DESCRIPTION = "Our family’s story and practical ways to understand feeding patterns, prepare for appointments, and use Maple Baby.";

export const metadata: Metadata = {
  title: "Blog",
  description: DESCRIPTION,
  alternates: { canonical: "/blog", types: { "application/rss+xml": [{ url: "/blog/feed.xml", title: "Maple blog" }] } },
  openGraph: siteOpenGraph("Blog | Maple", DESCRIPTION, "/blog"),
};

function byDate(posts: Post[]): { date: string; posts: Post[] }[] {
  const days: { date: string; posts: Post[] }[] = [];
  for (const p of posts) {
    const last = days[days.length - 1];
    if (last?.date === p.date) last.posts.push(p);
    else days.push({ date: p.date, posts: [p] });
  }
  return days;
}

export default function BlogIndex() {
  const days = byDate(publishedPosts());
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="site-display text-[2.75rem] leading-[1.05] text-mp-ink sm:text-[3.5rem]">Blog</h1>
        <p className="site-prose mt-4 text-[19px] leading-[1.6]">
          Our family’s story, the patterns we noticed, and how to put Maple’s features to use.
        </p>
        {days.map((day) => (
          <section key={day.date} className="mt-12">
            <p className="text-[14px] text-mp-ink-3">
              <time dateTime={day.date}>{postDateText(day.date)}</time>
            </p>
            <ol className="mt-3 divide-y divide-mp-line border-y border-mp-line">
              {day.posts.map((p) => (
                <li key={p.slug} className="py-7">
                  <h2 className="font-display text-[1.75rem] leading-[1.15] font-semibold text-balance text-mp-ink">
                    <Link href={`/blog/${p.slug}`} className="rounded-md hover:text-mp-accent-fg">
                      {p.title}
                    </Link>
                  </h2>
                  <p className="site-prose mt-2 text-[16px] leading-[1.55]">{p.description}</p>
                </li>
              ))}
            </ol>
          </section>
        ))}
        <p className="mt-8 text-[15px] text-mp-ink-2">
          <a className="site-link" href="/blog/feed.xml">
            RSS feed
          </a>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
