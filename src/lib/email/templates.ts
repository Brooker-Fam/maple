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

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

type Block = { kind: "p"; text: string } | { kind: "button"; label: string; href: string } | { kind: "link"; href: string } | { kind: "small"; text: string };

function page(subject: string, blocks: Block[]): string {
  const body = blocks
    .map((b) => {
      if (b.kind === "p") return `<p style="margin:0 0 16px">${escapeHtml(b.text)}</p>`;
      if (b.kind === "small") return `<p style="margin:32px 0 0;font-size:13px;color:#6b7464">${escapeHtml(b.text)}</p>`;
      if (b.kind === "link") return `<p style="margin:0 0 16px;font-size:14px;word-break:break-all"><a href="${escapeHtml(b.href)}">${escapeHtml(b.href)}</a></p>`;
      return `<p style="margin:8px 0 16px"><a href="${escapeHtml(b.href)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#1d4420;color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(b.label)}</a></p>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px 16px;font-family:${FONT};font-size:16px;line-height:1.5">
<div style="max-width:480px;margin:0 auto">
${body}
</div>
</body>
</html>
`;
}

function text(blocks: Block[]): string {
  return `${blocks.map((b) => (b.kind === "button" ? null : b.kind === "link" ? b.href : b.text)).filter((s) => s !== null).join("\n\n")}\n`;
}

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
  const subject = `${who} invited you to ${log} on Maple`;
  const blocks: Block[] = [
    { kind: "p", text: `${who} invited you to ${log} on Maple.` },
    { kind: "p", text: `Open this link to join. It works once, until ${expiry(d.expiresAt, d.timeZone)}.` },
    { kind: "button", label: baby ? `Join ${log}` : "Join the log", href: link },
    { kind: "link", href: link },
    { kind: "p", text: `If the link has expired, ask ${inviter ?? "whoever invited you"} for a new one. If you don’t know ${inviter ?? "them"}, you can ignore this email.` },
    { kind: "small", text: `You got this email because ${inviter ?? "someone"} invited this address to Maple. ${d.origin ?? MAPLE_ORIGIN}` },
  ];
  return { subject, text: text(blocks), html: page(subject, blocks) };
}

export type WelcomeEmail = {
  name: string | null;
  baby: string | null;
  origin?: string;
};

export function welcomeEmail(d: WelcomeEmail): Rendered {
  const name = cleanName(d.name);
  const baby = cleanName(d.baby);
  const app = safeLink(`${d.origin ?? MAPLE_ORIGIN}/maple`);
  const log = baby ? `${baby}’s log` : "Your family’s log";
  const subject = baby ? `${log} on Maple is ready` : "Your family’s log on Maple is ready";
  const blocks: Block[] = [
    ...(name ? [{ kind: "p" as const, text: `Hi ${name},` }] : []),
    { kind: "p", text: `${log} is ready.` },
    { kind: "button", label: "Open Maple", href: app },
    { kind: "link", href: app },
    { kind: "p", text: "On an iPhone, open it in Safari, tap Share, then Add to Home Screen. Notifications work only from the Home Screen app." },
    { kind: "p", text: "To add the rest of the family, open Family and go to Invite someone." },
    { kind: "p", text: "Reply to this email with a question or a problem. It reaches the person who makes Maple." },
  ];
  return { subject, text: text(blocks), html: page(subject, blocks) };
}
