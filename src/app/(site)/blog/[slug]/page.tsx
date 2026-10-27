import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { findPost, pagePosts, postDateText, postInstant } from "@/lib/blog";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return pagePosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = findPost((await params).slug);
  if (!post) return {};
  const url = `/blog/${post.slug}`;
  return {
    title: post.title,
    description: post.description,
    authors: [{ name: post.author }],
    alternates: { canonical: url },
    robots: post.draft ? { index: false, follow: false } : undefined,
    openGraph: {
      type: "article",
      siteName: "Maple",
      locale: "en_US",
      title: post.title,
      description: post.description,
      url,
      publishedTime: postInstant(post.date).toISOString(),
      authors: [post.author],
    },
  };
}

export default async function BlogPost({ params }: Props) {
  const post = findPost((await params).slug);
  if (!post) notFound();
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <article>
          <p className="text-[15px]">
            <Link className="site-link-quiet text-mp-ink-2" href="/blog">
              Blog
            </Link>
          </p>
          <h1 className="site-display mt-3 text-[2.5rem] leading-[1.06] text-mp-ink sm:text-[3.25rem]">{post.title}</h1>
          <p className="mt-4 text-[15px] text-mp-ink-3">
            <time dateTime={post.date}>{postDateText(post.date)}</time> · {post.author}
          </p>
          {post.draft && (
            <p className="mt-6 rounded-xl border border-mp-line bg-mp-surface px-4 py-3 text-[15px] text-mp-ink-2">
              Draft. It isn&rsquo;t listed anywhere and doesn&rsquo;t show in production.
            </p>
          )}
          <div className="site-legal site-post mt-10" dangerouslySetInnerHTML={{ __html: post.html }} />
        </article>
        <p className="mt-14 border-t border-mp-line pt-6 text-[15px] text-mp-ink-2">
          <Link className="site-link" href="/blog">
            All posts
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
