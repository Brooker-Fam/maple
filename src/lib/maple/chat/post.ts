import { createIdGenerator, type LanguageModel, type ToolSet } from "ai";
import { memberName } from "../insights";
import { dayBounds, dayKey, DEFAULT_TZ, startOfDay } from "../time";
import { StoreUnavailable } from "../store";
import type { Baby, Member } from "../types";
import { capsVerdict, type Usage } from "./caps";
import { mentionsCrisis } from "./crisis";
import { ChatInputError, denyPending, mergeApprovals, readIncoming, roughText, stepsTaken, titleFrom, userMessage, withCrisisHelp, type Incoming } from "./messages";
import type { ToolCopy } from "../mcp-tools";
import type { ModelPrice } from "./prices";
import { contextLine, stateLines } from "./prompt";
import type { LockedThread, UsageRow } from "./store";
import { CHAT_OFF, chatTurn } from "./turn";
import { CHAT_TERMS_NEEDED, THREAD_ID_RE, type ChatConsent, type ChatMessage, type ChatRefusal } from "./types";

/**
 * One POST to the chat, from the raw body to a streamed answer or a refusal.
 * Storage comes in through `deps`, so the route owns the database and a check
 * can run every early return against an in-memory store.
 */

export type ChatStore = {
  consent: (member: Member) => Promise<ChatConsent>;
  usageSince: (member: string, day: string, dayStart: Date, monthStart: Date) => Promise<Usage>;
  lockThread: (id: string, member: string, model: string, viewer: boolean, care: boolean) => Promise<LockedThread | "busy" | "missing">;
  releaseThread: (id: string) => Promise<void>;
  loadMessages: (threadId: string) => Promise<ChatMessage[]>;
  saveMessage: (threadId: string, member: string, m: ChatMessage) => Promise<void>;
  setTitle: (id: string, title: string) => Promise<void>;
  countMessage: (member: string, day: string) => Promise<void>;
  recordUsage: (u: UsageRow) => Promise<void>;
};

export type PostDeps = {
  store: ChatStore;
  /** The family's baby, members and words (its ToolCopy), read only once the request is worth answering. */
  household: () => Promise<{ familyId: number; baby: Baby; members: Member[]; copy: ToolCopy }>;
  /** The baby's name and nickname for the crisis check; a failed read leaves it the generic words. */
  crisisNames?: () => Promise<(string | null | undefined)[]>;
  model: LanguageModel;
  modelKey: string;
  price: ModelPrice | null;
  /** `care`: her medicine tools are in, and Maple's tools may read her page (chat_care). */
  tools: (opts: { born: boolean; care: boolean; copy: ToolCopy }) => ToolSet;
  /** The log as it stands (logState in mcp-tools.ts), for the new user message's [App] lines; `care` as for `tools`. */
  state: (opts: { care: boolean }) => Promise<string[]>;
  /** The family's chat budget, read only once the request is worth answering. */
  budget: () => Promise<{ day: bigint; month: bigint }>;
  now: Date;
  /** Gets every error already scrubbed (`scrub`), so whatever it logs carries no message text. */
  report: (error: Error) => void;
  waitUntil: (p: Promise<unknown>) => void;
};

export type PostBody = { threadId?: unknown; message?: unknown };

export const BUSY = "One message at a time: the last answer is still coming.";
export const CARE_CLOSED = "Her page is closed to the chat now, so a new chat starts here.";
export const STALE = "That question has moved on. Ask again if you still want it.";

const newMessageId = createIdGenerator({ prefix: "msg", size: 16 });

const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (body: ChatRefusal, status: number) => reply(body, status);

/**
 * An error's class and status, never its message or other fields: provider
 * errors can quote the request, and Postgres quotes the row (`where`,
 * "Failing row contains").
 */
export function scrub(error: unknown): Error {
  const e = error as { name?: unknown; statusCode?: unknown } | null;
  const name = typeof e?.name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(e.name) ? e.name : "chat_error";
  return new Error(typeof e?.statusCode === "number" ? `${name} ${e.statusCode}` : name);
}

function failure(error: unknown, report: (e: unknown) => void): Response {
  if (error instanceof StoreUnavailable) return reply({ error: "Maple's log is offline right now" }, 503);
  report(error);
  return reply({ error: "Something went wrong" }, 500);
}

/** No lines when reading them fails, since the tools can still read the log; the log being down still turns the message away. */
async function logStateOrNone(deps: Pick<PostDeps, "state"> & { report: (e: unknown) => void }, care: boolean): Promise<string[]> {
  try {
    return await deps.state({ care });
  } catch (e) {
    if (e instanceof StoreUnavailable) throw e;
    deps.report(e);
    return [];
  }
}

/** The crisis check reads the raw message first, so a cap, a busy thread or a store error still answers with the help card. */
export async function answerPost(body: PostBody, member: Member, raw: PostDeps): Promise<Response> {
  const report = (e: unknown) => raw.report(scrub(e));
  const deps = { ...raw, report };
  const names = raw.crisisNames ? await raw.crisisNames().catch(() => []) : [];
  const crisis = mentionsCrisis(roughText(body.message), names);
  const res = await postTurn(body, member, crisis, deps).catch((e: unknown) => failure(e, report));
  return crisis ? withCrisisHelp(res) : res;
}

async function postTurn(body: PostBody, member: Member, crisis: boolean, deps: Omit<PostDeps, "report"> & { report: (e: unknown) => void }): Promise<Response> {
  const { store } = deps;
  if (typeof body.threadId !== "string" || !THREAD_ID_RE.test(body.threadId)) return reply({ error: "thread is required" }, 400);
  let incoming: Incoming;
  try {
    incoming = readIncoming(body.message);
  } catch (e) {
    if (e instanceof ChatInputError) return reply({ error: e.message }, 400);
    throw e;
  }

  const price = deps.price;
  if (!price) {
    deps.report(Object.assign(new Error(), { name: "chat_model_unpriced" }));
    return refuse({ error: CHAT_OFF, code: "off" }, 503);
  }

  const consent = await store.consent(member);
  if (!consent.terms) return refuse({ error: CHAT_TERMS_NEEDED, code: "terms" }, 403);
  const care = consent.care && member.role !== "viewer";

  const { familyId, baby, members, copy } = await deps.household();
  const tz = baby.timezone || DEFAULT_TZ;
  const today = dayKey(deps.now, tz);
  const usage = await store.usageSince(member.email, today, dayBounds(today, tz)[0], startOfDay(`${today.slice(0, 8)}01`, tz));
  const limit = capsVerdict(usage, { role: member.role, newMessage: incoming.kind === "user", budget: await deps.budget() });
  if (limit) return refuse({ error: limit, code: "limit" }, 429);

  const viewer = member.role === "viewer";
  const thread = await store.lockThread(body.threadId, member.email, deps.modelKey, viewer, care);
  if (thread === "busy") return refuse({ error: BUSY, code: "busy" }, 409);
  if (thread === "missing") return reply({ error: "Not found" }, 404);

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await store.releaseThread(thread.id).catch(deps.report);
  };
  // Every way out of here releases the thread, except a started answer: its stream releases it once the reply is saved.
  let streaming = false;
  try {
    // Its history can quote her page (results and the replies that repeat them), which she has since closed to the chat.
    if (thread.careOpen && !care) return refuse({ error: CARE_CLOSED, code: "new_chat" }, 409);
    const history = await store.loadMessages(thread.id);
    let messages: ChatMessage[];
    let responseId: string;
    let stepsDone = 0;
    if (incoming.kind === "user") {
      const line = contextLine({ now: deps.now, baby, name: memberName(member.email, members), role: member.role, familyId });
      const stored = userMessage(newMessageId(), incoming.text, line, stateLines(await logStateOrNone(deps, care)));
      const prior = denyPending(history);
      await store.countMessage(member.email, today);
      for (const m of prior.changed) await store.saveMessage(thread.id, member.email, m);
      await store.saveMessage(thread.id, member.email, stored);
      if (!thread.title) await store.setTitle(thread.id, titleFrom(incoming.text));
      messages = [...prior.messages, stored];
      responseId = newMessageId();
    } else {
      const last = history[history.length - 1];
      const merged = last ? mergeApprovals(last, incoming.message) : null;
      if (!merged) return refuse({ error: STALE, code: "stale" }, 409);
      messages = [...history.slice(0, -1), merged];
      responseId = merged.id;
      stepsDone = stepsTaken(merged);
    }
    const res = await chatTurn({
      model: deps.model,
      modelKey: deps.modelKey,
      price,
      tools: deps.tools({ born: !!baby.born_at, care, copy }),
      viewer,
      care,
      copy,
      messages,
      responseId,
      crisis,
      stepsDone,
      deps: {
        save: (m) => store.saveMessage(thread.id, member.email, m),
        record: (u) => store.recordUsage({ ...u, member: member.email, threadId: thread.id, messageId: responseId, model: deps.modelKey }),
        release,
        report: deps.report,
        waitUntil: deps.waitUntil,
      },
    });
    streaming = true;
    return res;
  } finally {
    if (!streaming) await release();
  }
}
