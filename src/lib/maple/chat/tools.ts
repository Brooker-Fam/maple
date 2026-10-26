import { jsonSchema, tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ADMIN_ID } from "../auth";
import { registerCareTools } from "../care-mcp";
import { registerMapleTools, type Annotations, type Extra } from "../mcp-tools";
import type { Member } from "../types";
import type { ChatAlert, ChatReceipt, ChatToolOutput, HelpAbout } from "./types";

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

let cache: { all: Registration[]; mom: Set<string> } | null = null;

export function registrations(): { all: Registration[]; mom: Set<string> } {
  cache ??= { all: record(registerMapleTools), mom: new Set(record(registerCareTools).map((r) => r.name)) };
  return cache;
}

/** Her medicine list changes only in the app, where adding one is a real tap, not the model's word. */
export const EXCLUDED_TOOLS = new Set(["set_mom_medicine", "add_mom_medicines"]);

export function allowed(r: Registration, opts: { viewer: boolean; born: boolean; mom: Set<string> }): boolean {
  if (EXCLUDED_TOOLS.has(r.name)) return false;
  if (r.name === "record_birth" && opts.born) return false;
  if (opts.viewer) return r.ann.readOnlyHint && !opts.mom.has(r.name);
  return true;
}

/** A tool result past this is cut before the model reads it: it keeps every prompt under Haiku's 100K price step. */
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
  return {
    ok: !res.isError,
    text,
    write: opts.write,
    ...(alerts.length ? { alerts, ...(opts.mom ? { mom: true } : {}) } : {}),
    ...(saved.length ? { saved } : {}),
    ...(typeof dup === "number" ? { duplicateOf: dup } : {}),
    ...(sc.deleted === true && typeof sc.id === "number" ? { deleted: sc.id } : {}),
  };
}

const HELP_TEXT = "The help card is showing under your reply.";

/** `device`: the phone's X-Maple-Device id, so a dose logged here sends "Logged" to the other phones only. */
export function chatTools(member: Pick<Member, "email" | "role">, opts: { born: boolean; device?: string | null }): ToolSet {
  const { all, mom } = registrations();
  const sub = member.email === ADMIN_ID ? ADMIN_ID : `maple:${member.email}`;
  const extra = {
    signal: new AbortController().signal,
    requestId: "maple-chat",
    authInfo: { token: "maple-chat", clientId: "maple-chat", scopes: ["maple"], extra: { sub, via: "chat", device: opts.device ?? null } },
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("unsupported");
    },
  } as unknown as Extra;

  const viewer = member.role === "viewer";
  const set: ToolSet = {};
  for (const r of all) {
    if (!allowed(r, { viewer, born: opts.born, mom })) continue;
    const parser = z.object(r.shape);
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
          return { ok: false, write, text: `Those arguments don't fit ${r.name} (${why}). Nothing was saved; fix that and try again.` };
        }
        return toOutput(await r.handler(parsed.data, extra), { write, mom: isMom });
      },
      toModelOutput: ({ output }: { output: ChatToolOutput }) =>
        output.ok ? { type: "text", value: forModel(output.text) } : { type: "error-text", value: forModel(output.text) },
    });
  }
  set.show_help = tool({
    description:
      "Shows the app's help card under your reply: 911, 988 and the maternal mental health line for anyone (about: anyone or mom), or Maple's 911 signs and her pediatrician (about: maple). Call it every time you give the crisis line or the 911 emergency signs.",
    inputSchema: zodSchema(z.object({ about: z.enum(["maple", "mom", "anyone"]) })),
    execute: async ({ about }: { about: HelpAbout }): Promise<ChatToolOutput> => ({ ok: true, write: false, text: HELP_TEXT, about }),
    toModelOutput: () => ({ type: "text", value: HELP_TEXT }),
  });
  return set;
}

/**
 * The only calls that wait for a tap: delete_entry, and fix_mom_entry deleting
 * one of hers. undo_last (her doses too), restore_entry, update_entry and
 * fix_mom_entry's update (a dose's time, or skipped) run on the model's word,
 * and can move her next "OK after" time.
 */
export const TOOL_APPROVAL = {
  delete_entry: "user-approval" as const,
  fix_mom_entry: (input: { action?: unknown } | undefined) => (input?.action === "delete" ? ("user-approval" as const) : undefined),
};
