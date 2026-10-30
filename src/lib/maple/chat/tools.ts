import { jsonSchema, tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { careLevelOf, type CareLevel } from "../access";
import { ADMIN_ID } from "../auth";
import { registerCareTools } from "../care-mcp";
import { context, FAMILY_ONE_COPY, logState, registerMapleTools, type Annotations, type Extra, type ToolCopy } from "../mcp-tools";
import { OWNER_TOOLS, PEOPLE_CHANGE_TOOLS } from "../people-mcp";
import type { Member } from "../types";
import type { ChatAlert, ChatInvite, ChatMemoryChange, ChatReceipt, ChatToolOutput, HelpAbout } from "./types";
import type { ChatQuestionInput, ChatQuestionOutput } from "./types";
import { questionOutputSchema, questionSchema } from "./questions";
import { showChartTool } from "./chart-tools";
import { openScreenTool } from "./navigation-tools";
import { careReceiptOutput } from "./receipts";
import { searchEntriesTool } from "./search-tools";
import { settingsTools } from "./settings-tools";
import { webSearchTool, type SearchDeps } from "./web-search";

/**
 * The MCP tools as an AI SDK ToolSet for the in-app chat. The registrations
 * are recorded once with a stand-in server, then every call runs the same
 * handler Claude's connector does, with an `extra` carrying the member as
 * `via: "chat"`, so context(), the viewer checks and every result read the
 * same as over MCP.
 */

type Handler = (args: unknown, extra: Extra) => Promise<CallToolResult>;
type Registration = { name: string; description: string; shape: z.ZodRawShape; ann: Annotations; handler: Handler };
type Config = { description: string; inputSchema: z.ZodRawShape; annotations: Annotations };

function record(register: (server: McpServer) => void): Registration[] {
  const out: Registration[] = [];
  const recorder = {
    registerTool(name: string, cfg: Config, handler: Handler) {
      out.push({ name, description: cfg.description, shape: cfg.inputSchema, ann: cfg.annotations, handler });
    },
  };
  register(recorder as unknown as McpServer);
  return out;
}

/** One recording per family's words (its ToolCopy), so one family's names never reach another's chat. */
const cache = new Map<string, { all: Registration[]; mom: Set<string> }>();
const KEPT = 64;

const copyKey = (c: ToolCopy) => JSON.stringify([c.opening, c.tz, c.exampleBy, c.v.name, c.v.pronoun, c.v.mom, c.v.hasMom]);

export function registrations(copy: ToolCopy = FAMILY_ONE_COPY): { all: Registration[]; mom: Set<string> } {
  const key = copyKey(copy);
  let got = cache.get(key);
  if (!got) {
    got = { all: record((server) => registerMapleTools(server, copy)), mom: new Set(record((server) => registerCareTools(server, copy)).map((r) => r.name)) };
    if (cache.size >= KEPT) cache.delete(cache.keys().next().value!);
    cache.set(key, got);
  }
  return got;
}

/** Her medicine list changes only in the app, where adding one is a real tap, not the model's word. */
export const EXCLUDED_TOOLS = new Set(["set_mom_medicine", "add_mom_medicines"]);

/** The people tools that change something wait for a tap on their card, which stands in for a connector's `confirmed: true`. */
const TAP_CONFIRMED = new Set<string>(PEOPLE_CHANGE_TOOLS);

/** A tap-confirmed tool's shape as the chat's model sees it: its card is the yes, so no `confirmed` (people-mcp.ts reads a chat call as confirmed). */
function tapShape(shape: z.ZodRawShape): z.ZodRawShape {
  const { confirmed: _confirmed, ...rest } = shape;
  void _confirmed;
  return rest;
}

/**
 * `care`: her page as this member's chat reaches it: "none" until she has let
 * the chat see it (chat_care), and otherwise the member's level on it
 * (careLevelOf), so "view" brings only her reads. `owner`: only owners get
 * the tools that change who's in the family.
 */
export function allowed(r: Registration, opts: { viewer: boolean; born: boolean; care: CareLevel; mom: Set<string>; owner?: boolean }): boolean {
  if (EXCLUDED_TOOLS.has(r.name)) return false;
  if (r.name === "record_birth" && opts.born) return false;
  if (OWNER_TOOLS.has(r.name) && !opts.owner) return false;
  if (opts.mom.has(r.name) && (opts.care === "none" || (opts.care === "view" && !r.ann.readOnlyHint))) return false;
  if (opts.viewer) return r.ann.readOnlyHint;
  return true;
}

/** Her page for this member's chat: closed until she lets the chat see it, and always to a viewer (chatCareOpen); then their level (her own account always logs). */
export function chatCareLevel(member: Pick<Member, "role" | "care">, opts: { care: boolean; self?: boolean }): CareLevel {
  if (!opts.care || member.role === "viewer") return "none";
  return opts.self && (member.role === "owner" || member.role === "member") ? "log" : careLevelOf(member);
}

/** A tool result past this is cut before the model reads it, so one long answer can't balloon a step's prompt and its cost. */
export const MODEL_TEXT_MAX = 20_000;
const CUT = "\n[Cut off here: the result was too long. Ask for a shorter time window.]";

export function forModel(text: string): string {
  return text.length > MODEL_TEXT_MAX ? text.slice(0, MODEL_TEXT_MAX) + CUT : text;
}

export function toOutput(res: CallToolResult, opts: { write: boolean; mom: boolean }): ChatToolOutput {
  const text = res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  const sc = (res.structuredContent ?? {}) as Record<string, unknown>;
  const made = new Set<number>();
  const note = (r: unknown) => {
    const o = r as { created?: unknown; id?: unknown } | null;
    if (o?.created === true && typeof o.id === "number") made.add(o.id);
  };
  note(sc);
  if (Array.isArray(sc.results)) sc.results.forEach(note);
  const saved: ChatReceipt[] = [];
  for (const line of text.split("\n")) {
    const id = Number(/^Saved #(\d+): /.exec(line)?.[1]);
    if (made.has(id) && !saved.some((s) => s.id === id)) saved.push({ id, line });
  }
  const dup = (sc.possible_duplicate as { id?: unknown } | undefined)?.id;
  const alerts = Array.isArray(sc.alerts) ? (sc.alerts as ChatAlert[]) : [];
  const memory = memoryChangeOf(sc.memory_change);
  const invite = sc.invite_link as Partial<ChatInvite> | undefined;
  return {
    ok: !res.isError,
    text,
    write: opts.write,
    ...(res.isError ? { error: { kind: "unknown" as const } } : {}),
    ...(opts.mom ? careReceiptOutput(res) : {}),
    ...(alerts.length ? { alerts, ...(opts.mom ? { mom: true } : {}) } : {}),
    ...(saved.length ? { saved } : {}),
    ...(typeof dup === "number" ? { duplicateOf: dup } : {}),
    ...(sc.deleted === true && typeof sc.id === "number" ? { deleted: sc.id } : {}),
    ...(memory && !res.isError ? { memory } : {}),
    ...(typeof invite?.email === "string" && typeof invite.url === "string" && typeof invite.emailed === "boolean" ? { invite: { email: invite.email, url: invite.url, emailed: invite.emailed } } : {}),
  };
}

const MEMORY_CHANGES = new Set(["saved", "supported", "corrected", "resolved", "archived"]);

/** A memory tool's memory_change (memory/mcp.ts), kept to what its card shows. */
function memoryChangeOf(raw: unknown): ChatMemoryChange | null {
  const c = raw as { status?: unknown; kind?: unknown; fact?: unknown; previous_fact?: unknown } | null;
  if (!c || typeof c.status !== "string" || !MEMORY_CHANGES.has(c.status) || typeof c.fact !== "string" || typeof c.kind !== "string") return null;
  return { status: c.status as ChatMemoryChange["status"], kind: c.kind, fact: c.fact, ...(typeof c.previous_fact === "string" ? { previous: c.previous_fact } : {}) };
}

const HELP_TEXT = "The help card is showing under your reply.";

/**
 * `fam`: the signed-in member's family, which every call resolves again
 * (context() in mcp-tools.ts), as an MCP token's `fam` does. `device`: the
 * phone's X-Maple-Device id, so a dose logged here sends "Logged" to the
 * other phones only. `care` also rides on every call, so Maple's tools leave
 * her out of their results until she has turned it on. `memoryEpoch`: the
 * family memories' epoch this turn started with, which its memory writes
 * need (null when they couldn't be read, so those writes are refused).
 */
function chatExtra(member: Pick<Member, "email">, opts: { fam: number; care: boolean; device?: string | null; submittedAt?: Date; memoryEpoch?: number | null }): Extra {
  const sub = member.email === ADMIN_ID ? ADMIN_ID : `maple:${member.email}`;
  return {
    signal: new AbortController().signal,
    requestId: "maple-chat",
    authInfo: {
      token: "maple-chat",
      clientId: "maple-chat",
      scopes: ["maple"],
      extra: { sub, fam: opts.fam, via: "chat", device: opts.device ?? null, care: opts.care, memoryEpoch: opts.memoryEpoch ?? null, ...(opts.submittedAt ? { requestAt: opts.submittedAt.toISOString() } : {}) },
    },
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("unsupported");
    },
  } as unknown as Extra;
}

/** The log as the chat's tools would read it for this member at `now` (logState): the user message's [App] state lines. */
export async function chatLogState(member: Pick<Member, "email">, opts: { fam: number; care: boolean; now: Date }): Promise<string[]> {
  const ctx = await context(chatExtra(member, { fam: opts.fam, care: opts.care }));
  return logState({ ...ctx, now: opts.now });
}

/** `search`: the chat's model and the family's names for web_search (web-search.ts); without it there's no web search. */
export function chatTools(member: Pick<Member, "email" | "role" | "care">, opts: { fam: number; born: boolean; care: boolean; self?: boolean; copy: ToolCopy; device?: string | null; submittedAt?: Date; memoryEpoch?: number | null; search?: SearchDeps }): ToolSet {
  const { all, mom } = registrations(opts.copy);
  const vo = opts.copy.v;
  const care = chatCareLevel(member, opts);
  const extra = chatExtra(member, { ...opts, care: care !== "none", submittedAt: undefined });
  const writeExtra = chatExtra(member, { ...opts, care: care !== "none" });

  const viewer = member.role === "viewer";
  const owner = member.role === "owner";
  const set: ToolSet = {};
  for (const r of all) {
    if (!allowed(r, { viewer, born: opts.born, care, mom, owner })) continue;
    const parser = z.object(TAP_CONFIRMED.has(r.name) ? tapShape(r.shape) : r.shape);
    const write = !r.ann.readOnlyHint;
    const isMom = mom.has(r.name);
    set[r.name] = tool({
      description: r.description,
      // No validate: a bad input reaches execute and comes back as a result the model can fix, as it does over MCP.
      inputSchema: jsonSchema<Record<string, unknown>>(() => zodSchema(parser).jsonSchema),
      execute: async (raw): Promise<ChatToolOutput> => {
        const parsed = parser.safeParse(raw ?? {});
        if (!parsed.success) {
          const why = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
          return { ok: false, write, error: { kind: "validation" }, text: `Those arguments don't fit ${r.name} (${why}). Nothing was saved; fix that and try again.` };
        }
        return toOutput(await r.handler(parsed.data, write ? writeExtra : extra), { write, mom: isMom });
      },
      toModelOutput: ({ output }: { output: ChatToolOutput }) =>
        output.ok ? { type: "text", value: forModel(output.text) } : { type: "error-text", value: forModel(output.text) },
    });
  }
  set.show_help = tool({
    description: `Shows the app's help card under your reply: 911, 988 and the maternal mental health line for anyone (about: anyone or mom), or ${vo.name}'s 911 signs and ${vo.their} pediatrician (about: maple). Call it every time you give the crisis line or the 911 emergency signs.`,
    inputSchema: zodSchema(z.object({ about: z.enum(["maple", "mom", "anyone"]) })),
    execute: async ({ about }: { about: HelpAbout }): Promise<ChatToolOutput> => ({ ok: true, write: false, text: HELP_TEXT, about }),
    toModelOutput: () => ({ type: "text", value: HELP_TEXT }),
  });
  set.ask_user = tool<ChatQuestionInput, ChatQuestionOutput, Record<string, unknown>>({
    description: "Ask one necessary clarification with two to four short choices and a custom answer. Use only when the log and tools cannot supply a detail needed to fulfill the person's request. This pauses the reply until they answer; call it alone and do not perform the dependent write yet. It is not a delete approval. Choose a sensible chart or date range yourself unless the person needs to decide.",
    inputSchema: zodSchema(questionSchema),
    outputSchema: zodSchema(questionOutputSchema),
    // No execute: the UI renders the pending call and the request ends. The server validates the person's later answer.
    toModelOutput: ({ output }) => ({
      type: "text",
      value: output.status === "answered"
        ? JSON.stringify({ user_answer: output.answer, ...(output.choiceId ? { choice: output.choiceId } : {}) })
        : "The person sent a new message instead of choosing here. Read their newest message and do not repeat this question unless a necessary detail is still missing.",
    }),
  });
  const summary = all.find((r) => r.name === "daily_summary");
  if (summary) set.show_chart = showChartTool(extra, () => summary.handler({ days: 14 }, extra));
  set.search_entries = searchEntriesTool(extra);
  set.open_screen = openScreenTool({ viewer });
  Object.assign(set, settingsTools(extra));
  if (opts.search) set.web_search = webSearchTool(opts.search);
  return set;
}

/**
 * The only calls that wait for a tap: delete_entry, fix_mom_entry deleting
 * one of hers, and inviting, changing the access of or removing a person
 * (people-mcp.ts). undo_last (her doses too), restore_entry, update_entry and
 * fix_mom_entry's update (a dose's time, or skipped) run on the model's word,
 * and can move her next "OK after" time; so does cancel_invite, which only
 * stops a link nobody has used.
 */
export const TOOL_APPROVAL = {
  delete_entry: "user-approval" as const,
  fix_mom_entry: (input: { action?: unknown } | undefined) => (input?.action === "delete" ? ("user-approval" as const) : undefined),
  invite_person: "user-approval" as const,
  change_access: "user-approval" as const,
  remove_person: "user-approval" as const,
};
