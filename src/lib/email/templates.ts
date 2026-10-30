import { MAPLE_ORIGIN } from "@/lib/maple/origin";

export type Rendered = { subject: string; text: string; html: string };

const NAME_MAX = 40;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// A name lands in a subject line and in plain text, so it gets no line breaks or bidi overrides that could fake a line or a link.
export function cleanName(raw: string | null | undefined): string | null {
  const name = [...(raw ?? "").replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim()]
    .slice(0, NAME_MAX)
    .join("")
    .trim();
  return name || null;
}

function safeLink(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("email_bad_link");
  return url.href;
}

function expiry(at: Date, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).formatToParts(at);
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.weekday}, ${p.month} ${p.day} at ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// Georgia stands in for the site's Cormorant: a web font would be fetched from a server each time the email is opened.
const SERIF = "Georgia,'Times New Roman',Times,serif";

// The app's colors (src/app/maple/maple.css): day ones inline, which every mail app reads, and dark ones for the apps that honor prefers-color-scheme.
const LIGHT = { bg: "#f6f3ec", card: "#ffffff", line: "#e6e1d6", ink: "#1c2619", ink2: "#5b6356", accent: "#1d4420", onAccent: "#ffffff", link: "#2c5a2f", maple: "#b5452b" };
const DARK: typeof LIGHT = { bg: "#0e1310", card: "#171d18", line: "#2c342d", ink: "#ece7dc", ink2: "#a7aba0", accent: "#b4cc96", onAccent: "#16210f", link: "#b9d29c", maple: "#e5895e" };
type Color = keyof typeof LIGHT;
type Prop = "color" | "background-color" | "border-color";

const PAINT = {
  bg: { "background-color": "bg" },
  card: { "background-color": "card", "border-color": "line" },
  ink: { color: "ink" },
  ink2: { color: "ink2" },
  maple: { color: "maple" },
  num: { "background-color": "maple", color: "card" },
  rule: { "border-color": "line" },
  link: { color: "link" },
  btn: { "background-color": "accent" },
  "btn-text": { color: "onAccent" },
} satisfies Record<string, Partial<Record<Prop, Color>>>;
type Paint = keyof typeof PAINT;

const props = (name: Paint) => Object.entries(PAINT[name]) as [Prop, Color][];

/** class="m-…" style="…": the day colors inline, and a class the dark rules repaint. */
function paint(name: Paint, style: string, extra = ""): string {
  const colors = props(name).map(([prop, color]) => `${prop}:${LIGHT[color]}`);
  return `class="m-${name}${extra && ` ${extra}`}" style="${[style, ...colors].filter(Boolean).join(";")}"`;
}

function darkRules(selector: (cls: string, prop: Prop) => string): string {
  return (Object.keys(PAINT) as Paint[]).flatMap((name) => props(name).map(([prop, color]) => `${selector(`.m-${name}`, prop)}{${prop}:${DARK[color]} !important}`)).join("\n");
}

type Line = { label?: string; text: string };
type Step = { title: string; lines: Line[]; link?: { label: string; href: string } };

type Block =
  | { kind: "heading"; text: string }
  | { kind: "p"; text: string }
  /** `showLink` prints the address under the button, for a link someone may need to copy. */
  | { kind: "button"; label: string; href: string; showLink?: boolean }
  | { kind: "steps"; title: string; steps: Step[] };

type Message = {
  subject: string;
  /** The inbox's preview line, shown after the subject. */
  preheader: string;
  blocks: Block[];
  /** Quiet lines under the card; `href` is the site, shown by its host. */
  footer: { text: string; href?: string }[];
};

const rule = () => `<div ${paint("rule", "height:0;line-height:0;font-size:0;border-top:1px solid;margin:32px 0 28px")}>&nbsp;</div>`;

function stepsHtml(title: string, steps: Step[]): string {
  const rows = steps.map((s, i) => {
    const pad = i === steps.length - 1 ? 0 : 24;
    const lines = s.lines.map((l) => `<p ${paint("ink2", "margin:0 0 6px;font-size:15px;line-height:1.55")}>${l.label ? `<strong ${paint("ink", "font-weight:600")}>${escapeHtml(l.label)}:</strong> ` : ""}${escapeHtml(l.text)}</p>`);
    const link = s.link ? `<p style="margin:10px 0 0;font-size:15px;line-height:1.55"><a href="${escapeHtml(s.link.href)}" ${paint("link", "font-weight:600;text-decoration:underline")}>${escapeHtml(s.link.label)}</a></p>` : "";
    return `<tr>
<td width="44" valign="top" style="width:44px;padding:0 0 ${pad}px"><div ${paint("num", "width:28px;height:28px;border-radius:14px;font-size:14px;font-weight:700;line-height:28px;text-align:center")}>${i + 1}</div></td>
<td valign="top" style="padding:3px 0 ${pad}px"><p ${paint("ink", "margin:0 0 6px;font-size:16px;font-weight:600;line-height:1.4")}>${escapeHtml(s.title)}</p>
${lines.join("\n")}${link}</td>
</tr>`;
  });
  return `${rule()}
<p ${paint("maple", "margin:0 0 20px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase")}>${escapeHtml(title)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows.join("\n")}
</table>
${rule()}`;
}

function blockHtml(b: Block): string {
  if (b.kind === "heading") return `<h1 ${paint("ink", `margin:0 0 14px;font-family:${SERIF};font-size:30px;font-weight:normal;line-height:1.2;letter-spacing:-0.01em`, "m-h1")}>${escapeHtml(b.text)}</h1>`;
  if (b.kind === "p") return `<p ${paint("ink", "margin:0 0 16px;font-size:16px;line-height:1.6")}>${escapeHtml(b.text)}</p>`;
  if (b.kind === "steps") return stepsHtml(b.title, b.steps);
  const href = escapeHtml(b.href);
  // A table cell carries the button's color in mail apps that drop an inline-block link's background.
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 ${b.showLink ? 12 : 16}px">
<tr><td bgcolor="${LIGHT.accent}" ${paint("btn", "border-radius:12px")}><a href="${href}" ${paint("btn-text", `display:inline-block;padding:14px 28px;border-radius:12px;font-family:${SANS};font-size:16px;font-weight:600;line-height:20px;text-decoration:none`)}>${escapeHtml(b.label)}</a></td></tr>
</table>`;
  if (!b.showLink) return button;
  return `${button}
<p ${paint("ink2", "margin:0 0 16px;font-size:13px;line-height:1.5;word-break:break-all")}>Or copy this link: <a href="${href}" ${paint("link", "text-decoration:underline")}>${href}</a></p>`;
}

// Nothing here loads from a server when the email is opened: no images, web fonts or remote styles.
function html(m: Message): string {
  const footer = m.footer
    .map((f) => `<p style="margin:0 0 8px">${escapeHtml(f.text)}${f.href ? ` <a href="${escapeHtml(f.href)}" ${paint("ink2", "text-decoration:underline")}>${escapeHtml(new URL(f.href).host)}</a>` : ""}</p>`)
    .join("\n");
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(m.subject)}</title>
<style>
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
@media only screen and (max-width:520px){.m-wrap{padding:20px 10px 32px !important}.m-card{padding:30px 22px 14px !important}.m-h1{font-size:27px !important}}
</style>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
${darkRules((cls) => cls)}
}
</style>
<style>
a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;font:inherit !important}
${darkRules((cls, prop) => `[data-ogs${prop === "color" ? "c" : "b"}] ${cls}`)}
</style>
</head>
<body ${paint("bg", "margin:0;padding:0;width:100%")}>
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px">${escapeHtml(m.preheader)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.bg}" ${paint("bg", "")}>
<tr><td align="center" class="m-wrap" style="padding:32px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${SANS};text-align:left">
<tr><td style="padding:0 8px 18px"><span ${paint("ink", `font-family:${SERIF};font-size:26px;line-height:1;letter-spacing:-0.01em`)}>Maple</span></td></tr>
<tr><td ${paint("card", `padding:36px 32px 20px;border:1px solid;border-radius:20px;font-family:${SANS}`)}>
${m.blocks.map(blockHtml).join("\n")}
</td></tr>
<tr><td ${paint("ink2", `padding:24px 12px 0;font-family:${SANS};font-size:13px;line-height:1.55`)}>
${footer}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

function text(m: Message): string {
  const blocks = m.blocks.map((b) => {
    if (b.kind === "button") return `${b.label}: ${b.href}`;
    if (b.kind !== "steps") return b.text;
    const steps = b.steps.map((s, i) =>
      [`${i + 1}. ${s.title}`, ...s.lines.map((l) => (l.label ? `${l.label}: ${l.text}` : l.text)), ...(s.link ? [`${s.link.label}: ${s.link.href}`] : [])].join("\n")
    );
    return [b.title, ...steps].join("\n\n");
  });
  const footer = m.footer.map((f) => (f.href ? `${f.text} ${f.href}` : f.text)).join("\n");
  return `${[...blocks, footer].join("\n\n")}\n`;
}

function render(m: Message): Rendered {
  return { subject: m.subject, text: text(m), html: html(m) };
}

/** The site's address for a footer, without a trailing slash. */
const site = (origin: string | undefined) => new URL(safeLink(origin ?? MAPLE_ORIGIN)).origin;

export type InviteEmail = {
  inviter: string | null;
  baby: string | null;
  link: string;
  expiresAt: Date;
  /** The family's zone, so "until 4:05 PM" means what the inviter meant. */
  timeZone: string;
  origin?: string;
};

export function inviteEmail(d: InviteEmail): Rendered {
  const inviter = cleanName(d.inviter);
  const baby = cleanName(d.baby);
  const link = safeLink(d.link);
  const who = inviter ?? "Someone";
  const log = baby ? `${baby}’s log` : "their family’s log";
  const until = `Open this link to join. It works once, until ${expiry(d.expiresAt, d.timeZone)}.`;
  return render({
    subject: `${who} invited you to ${log} on Maple`,
    preheader: until,
    blocks: [
      { kind: "heading", text: `${who} invited you to ${log} on Maple.` },
      { kind: "p", text: until },
      { kind: "button", label: baby ? `Join ${log}` : "Join the log", href: link, showLink: true },
      { kind: "p", text: `If the link has expired, ask ${inviter ?? "whoever invited you"} for a new one. If you don’t know ${inviter ?? "them"}, you can ignore this email.` },
    ],
    footer: [{ text: `You got this email because ${inviter ?? "someone"} invited this address to Maple.`, href: site(d.origin) }],
  });
}

export type WelcomeEmail = {
  name: string | null;
  baby: string | null;
  origin?: string;
};

/**
 * Sent once a new family's log exists, while its owner is still setting it
 * up, so it covers what setup can't: getting Maple onto a phone, inviting with
 * the right access, and where logging happens. Every screen and choice it
 * names is checked against the app by pnpm check:email.
 */
export function welcomeEmail(d: WelcomeEmail): Rendered {
  const name = cleanName(d.name);
  const baby = cleanName(d.baby);
  const origin = d.origin ?? MAPLE_ORIGIN;
  const app = safeLink(`${origin}/maple`);
  // Typed into Safari: a link tapped in a mail app can open in that app's own browser, which can't add to the Home Screen.
  const typed = app.replace(/^https?:\/\//, "");
  const log = baby ? `${baby}’s log` : "Your family’s log";
  return render({
    subject: name ? `Welcome to Maple, ${name}` : "Welcome to Maple",
    preheader: `${log} is ready. Here are three quick things to do first.`,
    blocks: [
      { kind: "heading", text: name ? `Welcome, ${name}.` : "Welcome to Maple." },
      { kind: "p", text: `${log} is ready. See patterns in feeds, sleep and growth, and keep everyone caring for ${baby ?? "your baby"} on the same page.` },
      { kind: "button", label: "Open Maple", href: app },
      {
        kind: "steps",
        title: "Three things to do first",
        steps: [
          {
            title: "Add Maple to your Home Screen",
            lines: [
              { text: "It opens full screen, like an app. On iPhone it’s also the only way to get notifications." },
              { label: "iPhone", text: `In Safari, open ${typed}, tap Share, then Add to Home Screen. Open the new icon and sign in once more.` },
              { label: "Android", text: `In Chrome, open ${typed}, tap the ⋮ menu, then Add to Home screen.` },
            ],
          },
          {
            title: "Invite the people helping",
            lines: [
              { text: `Everyone logs from their own phone, so whoever’s up at 3 AM knows when ${baby ?? "the baby"} last ate.` },
              { text: "Tap your initial at the top right, then Settings → People & permissions. Choose Can log for anyone adding feeds and diapers, or Photos only for grandparents." },
            ],
            link: { label: "Open People & permissions", href: safeLink(`${origin}/maple#family/people`) },
          },
          {
            title: "Start logging",
            lines: [
              { text: "The buttons at the bottom of Today start a feed, log a diaper or time a nap with one tap." },
              { text: "Or type it in Chat the way you’d say it: “nursed 15 minutes on the left at 2, then a wet diaper.”" },
            ],
          },
        ],
      },
      { kind: "p", text: "Questions, ideas or something not working? Reply to this email." },
    ],
    footer: [
      { text: "Maple is a tracker, not medical advice. When in doubt, call your pediatrician." },
      { text: "You’re getting this email because you started your family’s log on Maple.", href: site(origin) },
    ],
  });
}
