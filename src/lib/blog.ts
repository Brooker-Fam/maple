import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import { STOOL_COLOR_INFO } from "@/lib/maple/guidelines";
import type { StoolColor } from "@/lib/maple/types";

export type PostMeta = {
  slug: string;
  title: string;
  description: string;
  date: string;
  author: string;
  draft: boolean;
};

export type Post = PostMeta & { html: string };

const DIR = join(process.cwd(), "content", "blog");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Straight quotes and apostrophes as typeset ones, the way the rest of the site writes them. */
export function smartQuotes(text: string): string {
  return text
    .replace(/(^|[\s(\[])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s(\[])'/g, "$1‘")
    .replace(/'/g, "’");
}

const isStoolColor = (c: string): c is StoolColor => Object.hasOwn(STOOL_COLOR_INFO, c);

/** `{swatch:mustard}` draws the app's own color for that stool swatch, so a post can't drift from the app's hex. */
const swatch: TokenizerAndRendererExtension = {
  name: "swatch",
  level: "inline",
  start: (src) => src.indexOf("{swatch:"),
  tokenizer(src) {
    const m = /^\{swatch:([a-z_]+)\}/.exec(src);
    return m && isStoolColor(m[1]) ? { type: "swatch", raw: m[0], color: m[1] } : undefined;
  },
  renderer: (token) => `<span class="site-swatch" style="background-color:${STOOL_COLOR_INFO[token.color as StoolColor].hex}" aria-hidden="true"></span>`,
};

const markdown = new Marked({
  gfm: true,
  extensions: [swatch],
  walkTokens(token) {
    if (token.type === "text" && !("tokens" in token && token.tokens?.length)) token.text = smartQuotes(token.text);
  },
});

export const draftsVisible = (env: Record<string, string | undefined> = process.env): boolean => env.VERCEL_ENV !== "production";

export function parsePost(slug: string, source: string): { meta: PostMeta; body: string } {
  const where = `content/blog/${slug}.md`;
  if (!SLUG_RE.test(slug)) throw new Error(`${where}: the file name must be lowercase words joined by hyphens`);
  const m = FRONT_RE.exec(source);
  if (!m) throw new Error(`${where}: missing front matter`);
  const fields = new Map<string, string>();
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${where}: can't read front matter line "${line}"`);
    const raw = kv[2].trim();
    fields.set(kv[1], raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw);
  }
  const text = (key: string) => {
    const v = fields.get(key);
    if (!v) throw new Error(`${where}: front matter needs ${key}`);
    return v;
  };
  const date = text("date");
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`${where}: date must be YYYY-MM-DD`);
  const draft = text("draft");
  if (draft !== "true" && draft !== "false") throw new Error(`${where}: draft must be true or false`);
  return {
    meta: { slug, title: smartQuotes(text("title")), description: smartQuotes(text("description")), date, author: text("author"), draft: draft === "true" },
    body: m[2],
  };
}

function readPost(slug: string): Post {
  const { meta, body } = parsePost(slug, readFileSync(join(DIR, `${slug}.md`), "utf8"));
  const html = markdown.parse(body, { async: false }).replace(/<table>/g, '<div class="site-table"><table>').replace(/<\/table>/g, "</table></div>");
  return { ...meta, html };
}

function slugs(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

const newestFirst = (a: PostMeta, b: PostMeta) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title);

export function pagePosts(env: Record<string, string | undefined> = process.env): Post[] {
  const show = draftsVisible(env);
  return slugs()
    .map(readPost)
    .filter((p) => show || !p.draft)
    .sort(newestFirst);
}

export function publishedPosts(): Post[] {
  return pagePosts({ VERCEL_ENV: "production" });
}

export function findPost(slug: string, env: Record<string, string | undefined> = process.env): Post | null {
  return pagePosts(env).find((p) => p.slug === slug) ?? null;
}

export function postDateText(date: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/** Noon UTC keeps the post's calendar day the same in every US time zone. */
export const postInstant = (date: string): Date => new Date(`${date}T12:00:00Z`);
