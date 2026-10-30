import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureServerException } from "@/lib/posthog-server";
import { ACCESS_WORD, careLevelOf, careLevelProblem, matchPerson, ROLE_FROM_WORD, type AccessRole, type CareLevel } from "./access";
import { BadRequest, Forbidden } from "./api";
import { ADMIN_ID, listInvites, normalizeEmail, type Invite } from "./auth";
import { carePersonName, getCarePerson } from "./care-store";
import { memberName } from "./insights";
import { FAMILY_ONE_COPY, READ_ANN, ToolError, context, fail, ok, voiceOf, type Annotations, type Ctx, type Extra, type ToolCopy } from "./mcp-tools";
import { MAPLE_HOST, MAPLE_ORIGIN } from "./origin";
import { cancelInvite, changeAccess, inviteByEmail, pageLevel, removePerson } from "./people";
import { NotFound, StoreUnavailable } from "./store";
import { formatDayLabel, dayKey } from "./time";
import type { Member, Role } from "./types";

/**
 * Who's in the family's log, as MCP tools (registered by registerMapleTools,
 * so Claude, ChatGPT and Maple's own chat all carry them): list_people for
 * anyone, and for owners invite_person (by email), change_access (a role on
 * the baby's log and a level on her page, access.ts), remove_person and
 * cancel_invite. The changes run through people.ts, the same as People
 * settings.
 *
 * Inviting, changing access and removing someone wait for the person's yes:
 * over a connector the model reads the change back and calls again with
 * `confirmed: true`; Maple's chat shows a card instead (TOOL_APPROVAL in
 * chat/tools.ts, which leaves `confirmed` out of the chat's schema), so a
 * chat call counts as confirmed only once that tap let it run. Emails are
 * shown to owners only.
 */

const ROUTE = "/api/maple/mcp";

const ACCESS = ["log", "view", "photos"] as const;
type AccessWord = (typeof ACCESS)[number];

/** A change waits for a yes: a connector's `confirmed: true`, or the chat's card (the only way a chat call runs). */
const confirmedBy = (ctx: Ctx, confirmed: boolean | null | undefined) => confirmed === true || ctx.who.via === "chat";

const roleText = (role: Role, baby: string): string =>
  role === "owner"
    ? "owner, with everything and managing people"
    : role === "member"
      ? `can log ${baby}'s log and moments`
      : role === "viewer"
        ? `sees ${baby}'s log and moments, no changes`
        : "shared moments and photos only";

const LEVEL_TEXT: Record<CareLevel, string> = { none: "hidden", view: "can view (not her check-ins)", log: "can view and add" };

/** "Dana's page: hidden", or null where the family has no page for her. */
const pageText = (level: CareLevel, page: string | null) => (page ? `${page}: ${LEVEL_TEXT[level]}` : null);

type Page = { person: string | null; label: string | null };

async function pageOf(ctx: Ctx): Promise<Page> {
  const person = await getCarePerson(ctx.fam);
  return { person: person?.member ?? null, label: person ? `${carePersonName(person, ctx.members)}'s page` : null };
}

/** The caller as people.ts takes them: the admin login reads as the member it acts as. */
const actor = (ctx: Ctx) => ({ email: ctx.who.id, role: ctx.who.role, display_name: ctx.members.find((m) => m.email === ctx.who.id)?.display_name ?? null });

function ownerOnly(ctx: Ctx, what: string) {
  if (ctx.who.role !== "owner") throw new ToolError(`Only an owner of this log can ${what}. Ask an owner to do it in Maple's Log → Settings → People & permissions.`);
}

/** Someone in this family by the id list_people gave, or by a name only one person has. */
function findPerson(ctx: Ctx, query: string): Member {
  const people = ctx.members.map((m) => ({ ...m, id: m.email, name: memberName(m.email, ctx.members) }));
  const hit = matchPerson(query, people);
  if ("found" in hit) return ctx.members.find((m) => m.email === hit.found.id)!;
  if ("ambiguous" in hit) throw new ToolError(`More than one person here is called "${query.trim()}": ${hit.ambiguous.map((p) => (ctx.who.role === "owner" ? `${p.name} (${p.id})` : p.name)).join(", ")}. Say which one, by id from list_people.`);
  throw new ToolError(`Nobody in this family's log is "${query.trim()}". Call list_people for who's here.`);
}

/**
 * What a role and a level on her page give, read back: "can log June's log
 * and moments; Dana's page: hidden". `care` as stored (null: the role's
 * default); her page is left out where the family has none.
 */
function accessText(role: Role, care: CareLevel | null | undefined, ctx: Ctx, page: Page): string {
  const mom = role === "owner" || role === "photos" ? null : pageText(careLevelOf({ role, care: care ?? null }), page.label);
  return `${roleText(role, voiceOf(ctx).name)}${mom ? `; ${mom}` : ""}`;
}

/** A member's own access, read back: her own account always has her page. */
function memberAccess(m: Member, ctx: Ctx, page: Page): string {
  if (page.person !== m.email) return accessText(m.role, m.care, ctx, page);
  return `${roleText(m.role, voiceOf(ctx).name)}${page.label ? `; it's ${page.label.replace(/'s page$/, "")}'s own page` : ""}`;
}

/** One person's line: "Blake (blake@example.com): can log June's log and moments; Dana's page: hidden". */
function personLine(m: Member, ctx: Ctx, page: Page): string {
  const name = memberName(m.email, ctx.members);
  const id = ctx.who.role === "owner" && m.email !== ADMIN_ID && !m.email.startsWith("invite:") ? ` (${m.email})` : "";
  const you = m.email === ctx.who.id ? ", you" : "";
  return `${name}${id}${you}: ${memberAccess(m, ctx, page)}`;
}

function inviteLine(i: Invite, ctx: Ctx, page: Page): string {
  const who = i.email ?? (i.display_name ? `${i.display_name} (a one-time link)` : "a one-time link");
  const expires = formatDayLabel(dayKey(new Date(i.expires_at), ctx.tz), dayKey(ctx.now, ctx.tz));
  return `i${i.id} ${who}: ${accessText(i.role, i.care, ctx, page)}; expires ${expires === "Today" ? "today" : expires}`;
}

function addPeopleTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: S; annotations: Annotations; invoking: string; invoked: string },
  run: (args: ShapeOutput<S>, ctx: Ctx) => Promise<CallToolResult>
) {
  const handler = async (args: ShapeOutput<S>, extra: Extra): Promise<CallToolResult> => {
    try {
      const ctx = await context(extra);
      return await run(args, ctx);
    } catch (err) {
      if (err instanceof ToolError) return fail(err.message);
      // people.ts's own words, fit to show.
      if (err instanceof BadRequest || err instanceof Forbidden || err instanceof NotFound) return fail(`${err.message.replace(/\.$/, "")}. Nothing changed.`);
      if (err instanceof StoreUnavailable) return fail("Maple's Log can't reach its database right now, so nothing changed. Try again in a minute.");
      // Its code or class only, never the message (Postgres quotes rows).
      const code = (err as { code?: unknown } | null)?.code;
      const scrubbed = new Error(typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "people_mcp_error");
      console.error(`Maple MCP ${name} error: ${scrubbed.message}`);
      await captureServerException(scrubbed, { tool: name, route: ROUTE });
      return fail("Something went wrong inside Maple's Log. Call list_people to see where things stand before trying again.");
    }
  };
  server.registerTool(
    name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.inputSchema,
      annotations: { title: cfg.title, ...cfg.annotations },
      _meta: { "openai/toolInvocation/invoking": cfg.invoking, "openai/toolInvocation/invoked": cfg.invoked },
    },
    handler as unknown as ToolCallback<S>
  );
}

/** The tools that change who's in the family: owners only, and in Maple's chat each waits for a tap on its card. */
export const PEOPLE_CHANGE_TOOLS = ["invite_person", "change_access", "remove_person"] as const;
export const OWNER_TOOLS = new Set<string>([...PEOPLE_CHANGE_TOOLS, "cancel_invite"]);

export function registerPeopleTools(server: McpServer, copy: ToolCopy = FAMILY_ONE_COPY) {
  const vo = copy.v;
  const MOM = vo.mom;
  const confirmed = () =>
    z
      .boolean()
      .nullish()
      .describe("Only after you read this change back to the user and they said yes to it: true makes it. Without it nothing changes, and the result is the exact change to read back.");
  const access = () =>
    z
      .enum(ACCESS)
      .describe(`Their access to ${vo.name}'s log and moments: "log" adds and edits them, "view" only sees them, "photos" sees shared moments and photos only. Ask the user if they didn't say.`);
  const momPage = () =>
    z
      .enum(["none", "view", "log"])
      .nullish()
      .describe(`${MOM}'s page (her medicines and doses, food and drinks, temperatures and questions for her OB): "log" sees and adds, "view" only sees (never her check-ins), "none" hides it. Leave it out for the default: "log" with access "log", otherwise "none". "view" needs access "log" or "view"; "log" needs access "log".`);
  const person = () => z.string().min(1).max(254).describe("Who: their id (email) from list_people, or their name when only one person has it.");

  addPeopleTool(
    server,
    "list_people",
    {
      title: "Who's in the family log",
      description: `Everyone in this family's Maple's Log and what each can reach: their role on ${vo.name}'s log ("owner", "log", "view" or "photos") and ${MOM}'s page ("log", "view" or "none"). Owners also see each person's email (their id for change_access and remove_person) and the invites still waiting. E.g. "who can see ${MOM}'s medicines?", "who have we invited?".`,
      inputSchema: {},
      annotations: READ_ANN,
      invoking: "Checking who's in the family…",
      invoked: "Family list ready",
    },
    async (_a, ctx) => {
      const page = await pageOf(ctx);
      const owner = ctx.who.role === "owner";
      const invites = owner ? await listInvites(ctx.fam) : [];
      const lines = ctx.members.map((m) => personLine(m, ctx, page));
      const summary = `${ctx.members.length} ${ctx.members.length === 1 ? "person" : "people"} in the family log: ${lines.join(" · ")}.${owner ? (invites.length ? ` Waiting invites: ${invites.map((i) => inviteLine(i, ctx, page)).join(" · ")}.` : " No invites waiting.") : ""}`;
      return ok(summary, {
        people: ctx.members.map((m) => ({
          name: memberName(m.email, ctx.members),
          ...(owner ? { id: m.email } : {}),
          ...(m.email === ctx.who.id ? { you: true } : {}),
          access: ACCESS_WORD[m.role],
          ...(page.person ? { mom_page: pageLevel(m, page.person) } : {}),
          ...(page.person === m.email ? { her_page: true } : {}),
        })),
        ...(owner
          ? {
              invites: invites.map((i) => ({
                id: `i${i.id}`,
                ...(i.email ? { email: i.email } : { link: true }),
                ...(i.display_name ? { name: i.display_name } : {}),
                access: ACCESS_WORD[i.role],
                ...(page.person ? { mom_page: careLevelOf({ role: i.role, care: i.care }) } : {}),
                expires_at: i.expires_at,
              })),
            }
          : {}),
      });
    }
  );

  addPeopleTool(
    server,
    "invite_person",
    {
      title: "Invite someone to the family log",
      description: `Owners only. Invites one person by email to this family's Maple's Log with the access you name: to ${vo.name}'s log and moments ("access"), and to ${MOM}'s page ("mom_page"). They join by signing in with that email address (Google, Apple or an email code); the invite works only for that address. Use only when the user asked to add this person, in their own words. A one-time link for someone without an email is made in the app (Settings → People & permissions).`,
      inputSchema: {
        email: z.string().min(3).max(254).describe("Their email address, exactly as the user gave it."),
        access: access(),
        mom_page: momPage(),
        name: z.string().max(40).nullish().describe("What to call them in the log, if the user said (\"Grandma\"). Otherwise their sign-in name is used."),
        confirmed: confirmed(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      invoking: "Writing the invite…",
      invoked: "Invite ready",
    },
    async (a, ctx) => {
      ownerOnly(ctx, "invite people");
      const email = normalizeEmail(a.email);
      if (!email) throw new ToolError(`"${a.email}" isn't an email address. Ask the user for theirs.`);
      const role: AccessRole = ROLE_FROM_WORD[a.access as AccessWord];
      const care = a.mom_page ?? null;
      const problem = care ? careLevelProblem(role, care) : null;
      if (problem) throw new ToolError(problem);
      const already = ctx.members.find((m) => m.email === email);
      const page = await pageOf(ctx);
      if (already) {
        return ok(`${email} is already in the family log (${memberAccess(already, ctx, page)}). Nothing changed; change_access changes what they reach.`, { already: true });
      }
      const what = `invite ${email}${a.name ? ` as "${a.name}"` : ""}, ${accessText(role, care, ctx, page)}`;
      if (!confirmedBy(ctx, a.confirmed)) {
        return ok(`Nothing sent yet. Read this back to the user: ${what}. Only if they say yes, call invite_person again with confirmed: true.`, { confirm_needed: true, email, access: a.access, ...(page.person ? { mom_page: careLevelOf({ role, care }) } : {}) });
      }
      const out = await inviteByEmail(ctx.fam, actor(ctx), { email, role, care, ...(a.name ? { name: a.name } : {}), origin: MAPLE_ORIGIN });
      if (out.kind === "member") return ok(`${email} is already in the family log. Nothing changed.`, { already: true });
      if (out.kind === "added") {
        return ok(`Added ${email} to the family log: ${accessText(role, care, ctx, page)}. They sign in at ${MAPLE_HOST}/maple with that email address.`, { added: true, email });
      }
      const how = out.emailed
        ? "Maple emailed them the invite."
        : ctx.who.via === "chat"
          ? "Email isn't set up, so copy the invite link from the card and send it to them."
          : "Email isn't set up, so send them the link below yourself.";
      const res = ok(`Invited ${email}: ${accessText(role, care, ctx, page)}. ${how} It works once, for 7 days, and only when they sign in as that address.`, {
        invited: true,
        email,
        emailed: out.emailed,
        // In the chat the link stays on the card, out of the model's text.
        ...(!out.emailed && ctx.who.via !== "chat" ? { link: out.url } : {}),
      });
      if (ctx.who.via === "chat") res.structuredContent = { ...res.structuredContent, invite_link: { email, url: out.url, emailed: out.emailed } };
      return res;
    }
  );

  addPeopleTool(
    server,
    "change_access",
    {
      title: "Change what someone can reach",
      description: `Owners only. Changes one person's access to ${vo.name}'s log and moments ("access") and/or to ${MOM}'s page ("mom_page"); give at least one. Owners always have everything, and ${MOM} always has her own page. Use only when the user asked for this change, in their own words. E.g. "let Grandpa log diapers but not see ${MOM}'s medicines" → access "log", mom_page "none".`,
      inputSchema: {
        person: person(),
        access: access().nullish(),
        mom_page: momPage(),
        confirmed: confirmed(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      invoking: "Changing their access…",
      invoked: "Access changed",
    },
    async (a, ctx) => {
      ownerOnly(ctx, "change what people can reach");
      if (a.access == null && a.mom_page == null) throw new ToolError("Say what to change: access, mom_page, or both.");
      const target = findPerson(ctx, a.person);
      const name = memberName(target.email, ctx.members);
      if (target.email === ctx.who.id) throw new ToolError("You can't change your own access.");
      if (target.role === "owner") throw new ToolError(`${name} is an owner, and owners always have everything.`);
      const page = await pageOf(ctx);
      const role: AccessRole = a.access ? ROLE_FROM_WORD[a.access] : (target.role as AccessRole);
      const care = a.mom_page ?? undefined;
      const problem = care ? careLevelProblem(role, care) : null;
      if (problem) throw new ToolError(problem);
      if (care && care !== "log" && page.person === target.email) throw new ToolError(`${name} is ${MOM}: it's her own page, so she always has it.`);
      const what = `${name} from ${memberAccess(target, ctx, page)}, to ${accessText(role, care ?? target.care, ctx, page)}`;
      if (!confirmedBy(ctx, a.confirmed)) {
        return ok(`Nothing changed yet. Read this back to the user: change ${what}. Only if they say yes, call change_access again with confirmed: true.`, { confirm_needed: true });
      }
      const done = await changeAccess(ctx.fam, actor(ctx), target.email, { ...(a.access ? { role } : {}), ...(care ? { care } : {}) });
      return ok(`Changed ${name}'s access: ${memberAccess(done.after, ctx, page)}. It applies now, on every phone and assistant they use.`, {
        changed: true,
        access: ACCESS_WORD[done.after.role],
        ...(page.person ? { mom_page: pageLevel(done.after, page.person) } : {}),
      });
    }
  );

  addPeopleTool(
    server,
    "remove_person",
    {
      title: "Remove someone from the family log",
      description: `Owners only. Removes one person from this family's Maple's Log: their sign-ins, connected assistants and Siri keys stop working at once, and they can't sign back in unless invited again. What they logged stays. Never an owner, and never yourself. Use only when the user asked to remove this person, in their own words.`,
      inputSchema: { person: person(), confirmed: confirmed() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      invoking: "Removing them…",
      invoked: "Removed",
    },
    async (a, ctx) => {
      ownerOnly(ctx, "remove people");
      const target = findPerson(ctx, a.person);
      const name = memberName(target.email, ctx.members);
      if (target.email === ctx.who.id) throw new ToolError("You can't remove yourself here. To leave this log, use Maple's Log → Settings → People & permissions.");
      if (target.email === ADMIN_ID) throw new ToolError("The admin login is turned off in Maple's Log → Settings → People & permissions, not here.");
      if (target.role === "owner") throw new ToolError(`${name} is an owner, and owners can't be removed.`);
      const page = await pageOf(ctx);
      if (!confirmedBy(ctx, a.confirmed)) {
        return ok(`Nothing changed yet. Read this back to the user: remove ${personLine(target, ctx, page)}. Only if they say yes, call remove_person again with confirmed: true.`, { confirm_needed: true });
      }
      await removePerson(ctx.fam, actor(ctx), target.email);
      return ok(`Removed ${name} from the family log. Their sign-ins, connected assistants and Siri keys stop working now; what they logged stays. Inviting them again lets them back in.`, { removed: true });
    }
  );

  addPeopleTool(
    server,
    "cancel_invite",
    {
      title: "Cancel an invite",
      description: "Owners only. Cancels one invite nobody has used yet, so its link stops working: by its id from list_people (\"i12\") or the email it went to. Use only when the user asked.",
      inputSchema: { invite: z.string().min(2).max(254).describe('The invite\'s id from list_people ("i12"), or the email address it was sent to.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      invoking: "Cancelling the invite…",
      invoked: "Invite cancelled",
    },
    async (a, ctx) => {
      ownerOnly(ctx, "cancel invites");
      const open = await listInvites(ctx.fam);
      const raw = a.invite.trim();
      const id = /^i?\d{1,9}$/i.test(raw) ? Number(raw.replace(/^i/i, "")) : NaN;
      const email = normalizeEmail(raw);
      const found = open.find((i) => i.id === id) ?? (email ? open.find((i) => i.email === email) : undefined);
      if (!found) throw new ToolError(`No waiting invite matches "${raw}". Call list_people for the invites still open.`);
      await cancelInvite(ctx.fam, actor(ctx), found.id);
      return ok(`Cancelled the invite for ${found.email ?? found.display_name ?? "a one-time link"}. Its link no longer works.`, { cancelled: `i${found.id}` });
    }
  );
}
