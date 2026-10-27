import { isToolUIPart, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { Usage } from "../../src/lib/maple/chat/caps";
import { answerPost, type ChatStore } from "../../src/lib/maple/chat/post";
import type { ModelPrice, StepTokens } from "../../src/lib/maple/chat/prices";
import type { LockedThread, UsageRow } from "../../src/lib/maple/chat/store";
import { chatTools, registrations, toOutput } from "../../src/lib/maple/chat/tools";
import { FAMILY_ONE_COPY, type ToolCopy } from "../../src/lib/maple/mcp-tools";
import type { ChatConsent, ChatMessage, ChatToolOutput } from "../../src/lib/maple/chat/types";
import type { Baby, Member } from "../../src/lib/maple/types";
import { fail } from "./result";
import { MIN, Sim, TZ } from "./sim";
import { runHandler } from "./stubs";

/**
 * One scenario through the chat's real POST (answerPost: the crisis check,
 * the context line, the prompt, the tool definitions, providerOptions and the
 * step loop), against a real model on AI Gateway. Storage is in memory and
 * every tool's execute is a stand-in reading a made-up log, so nothing
 * touches a database.
 */

export const ME: Member = { email: "alex@example.com", role: "owner", display_name: "Alex", emoji: null, color: null };
const MOM: Member = { email: "brittany@example.com", role: "member", display_name: "Brittany", emoji: null, color: null };

export type Call = { turn: number; name: string; input: unknown; ok: boolean; write: boolean; text: string; stubbed: boolean };

export type TurnOut = {
  say: string;
  status: number;
  reply: string;
  help: string | null;
  pending: { tool: string; input: unknown }[];
  refusal: string | null;
  streamErrors: string[];
  reported: string[];
  latencyMs: number;
  steps: number;
  tokens: StepTokens;
  costMicro: bigint;
};

const zeroTokens = (): StepTokens => ({ prompt: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });

function stubbedTools(real: ToolSet, sim: Sim, calls: Call[], turn: () => number): ToolSet {
  const { all, mom } = registrations();
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(real)) {
    const reg = all.find((r) => r.name === name);
    if (!reg) {
      const execute = t.execute;
      out[name] = {
        ...t,
        execute: async (input: unknown, options: unknown) => {
          const res = (await (execute as (i: unknown, o: unknown) => Promise<ChatToolOutput>)(input, options)) as ChatToolOutput;
          calls.push({ turn: turn(), name, input, ok: res.ok, write: false, text: res.text, stubbed: true });
          return res;
        },
      } as ToolSet[string];
      continue;
    }
    const parser = z.object(reg.shape);
    const write = !reg.ann.readOnlyHint;
    out[name] = {
      ...t,
      execute: async (raw: unknown): Promise<ChatToolOutput> => {
        const parsed = parser.safeParse(raw ?? {});
        let output: ChatToolOutput;
        let stubbed = true;
        if (!parsed.success) {
          const why = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
          output = { ok: false, write, text: `Those arguments don't fit ${name} (${why}). Nothing was saved; fix that and try again.` };
        } else {
          const res = runHandler(name, parsed.data as Record<string, unknown>, sim);
          stubbed = res !== null;
          output = toOutput(res ?? fail(`The test bench has no stand-in for ${name}, so nothing was done.`), { write, mom: mom.has(name) });
        }
        calls.push({ turn: turn(), name, input: raw, ok: output.ok, write, text: output.text, stubbed });
        return output;
      },
    } as ToolSet[string];
  }
  return out;
}

type Thread = { member: string; busy: boolean; title: string | null; careOpen: boolean; messages: ChatMessage[] };

/** ChatStore in memory. Any method the store gains later answers undefined rather than failing the run. */
function memStore(care: boolean) {
  const threads = new Map<string, Thread>();
  const usage: UsageRow[] = [];
  const consent: ChatConsent = { terms: true, care, self: false };
  const known: ChatStore = {
    consent: async () => consent,
    usageSince: async (): Promise<Usage> => ({ mine: 0, day: BigInt(0), month: BigInt(0) }),
    lockThread: async (id, member, _model, _viewer, careNow): Promise<LockedThread | "busy" | "missing"> => {
      const t = threads.get(id) ?? { member, busy: false, title: null, careOpen: careNow, messages: [] };
      threads.set(id, t);
      if (t.busy) return "busy";
      t.busy = true;
      t.careOpen ||= careNow;
      return { id, title: t.title, userMessages: t.messages.filter((m) => m.role === "user").length, lastPrompt: 0, careOpen: t.careOpen };
    },
    releaseThread: async (id) => {
      threads.get(id)!.busy = false;
    },
    loadMessages: async (id) => structuredClone(threads.get(id)?.messages ?? []),
    saveMessage: async (id, _member, m) => {
      const ms = threads.get(id)!.messages;
      const i = ms.findIndex((x) => x.id === m.id);
      if (i >= 0) ms[i] = structuredClone(m);
      else ms.push(structuredClone(m));
    },
    setTitle: async (id, title) => {
      threads.get(id)!.title ??= title;
    },
    countMessage: async () => {},
    recordUsage: async (u) => void usage.push(u),
  };
  const store = new Proxy(known, { get: (o, k) => (typeof k === "string" && k !== "then" && !(k in o) ? async () => undefined : o[k as keyof ChatStore]) });
  const idle = async (id: string) => {
    for (let i = 0; i < 500 && threads.get(id)?.busy; i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { store, threads, usage, idle };
}

function baby(sim: Sim): Baby {
  return { id: 1, name: "Maple Example", nickname: "Maple", sex: "female", due_date: "2026-10-22", born_at: new Date(sim.bornAt).toISOString(), birth_weight_g: 3400, birth_length_cm: 50, birth_head_cm: 34, timezone: TZ, settings: {} };
}

function streamErrors(sse: string): string[] {
  const out: string[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as { type?: string; errorText?: string };
      if (chunk.type === "error") out.push(chunk.errorText ?? "error");
    } catch {
      /* not JSON */
    }
  }
  return out;
}

export type Played = { before: Sim; after: Sim; calls: Call[]; turns: TurnOut[] };

/** `model` is the Gateway id (and price key); `languageModel` stands in for it in a dry run. */
export async function play(opts: { sim: Sim; turns: { say: string; afterMin?: number }[]; model: string; languageModel?: LanguageModel; price: ModelPrice; care: boolean; threadId: string }): Promise<Played> {
  const { sim } = opts;
  const before = sim.clone();
  const mem = memStore(opts.care);
  const calls: Call[] = [];
  const turns: TurnOut[] = [];
  let turn = 0;
  for (const [i, t] of opts.turns.entries()) {
    turn = i;
    sim.now += (t.afterMin ?? 0) * MIN;
    const waits: Promise<unknown>[] = [];
    const reported: string[] = [];
    const usedBefore = mem.usage.length;
    const seenBefore = mem.threads.get(opts.threadId)?.messages.length ?? 0;
    // Not annotated as PostDeps, so the same object fits it with or without `state` (the [App] log lines).
    const deps = {
      store: mem.store,
      household: async () => ({ familyId: 1, baby: baby(sim), members: [ME, MOM], copy: FAMILY_ONE_COPY }),
      model: opts.languageModel ?? opts.model,
      modelKey: opts.model,
      price: opts.price,
      tools: (o: { born: boolean; care: boolean; copy: ToolCopy }) => stubbedTools(chatTools(ME, { ...o, fam: 1, device: null }), sim, calls, () => turn),
      state: async (o: { care: boolean }) => sim.logState(o.care),
      budget: async () => ({ day: BigInt(1_000_000_000), month: BigInt(1_000_000_000) }),
      now: new Date(sim.now),
      report: (e: Error) => void reported.push(e.message),
      waitUntil: (p: Promise<unknown>) => void waits.push(p),
    };
    const started = Date.now();
    const res = await answerPost({ threadId: opts.threadId, message: { id: `u${i}`, role: "user", parts: [{ type: "text", text: t.say }] } }, ME, deps);
    const body = await res.text();
    await Promise.all(waits);
    await mem.idle(opts.threadId);
    const latencyMs = Date.now() - started;
    const fresh = (mem.threads.get(opts.threadId)?.messages ?? []).slice(seenBefore);
    const answer = fresh.filter((m) => m.role === "assistant").pop();
    const parts = answer?.parts ?? [];
    const rows = mem.usage.slice(usedBefore);
    const tokens = rows.reduce((n, r) => ({ prompt: n.prompt + r.tokens.prompt, fresh: n.fresh + r.tokens.fresh, cacheRead: n.cacheRead + r.tokens.cacheRead, cacheWrite: n.cacheWrite + r.tokens.cacheWrite, output: n.output + r.tokens.output, reasoning: n.reasoning + r.tokens.reasoning }), zeroTokens());
    let refusal: string | null = null;
    let help: string | null = (parts.find((p) => p.type === "data-help") as { data?: { reason?: string } } | undefined)?.data?.reason ?? null;
    if (!res.ok) {
      const j = JSON.parse(body || "{}") as { error?: string; help?: string };
      refusal = j.error ?? `HTTP ${res.status}`;
      help ??= j.help ?? null;
    }
    turns.push({
      say: t.say,
      status: res.status,
      reply: parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim(),
      help,
      pending: parts.filter((p) => isToolUIPart(p) && p.state === "approval-requested").map((p) => ({ tool: p.type.replace(/^tool-/, ""), input: (p as { input?: unknown }).input })),
      refusal,
      streamErrors: res.ok ? streamErrors(body) : [],
      reported,
      latencyMs,
      steps: rows.length,
      tokens,
      costMicro: rows.reduce((n, r) => n + r.costMicro, BigInt(0)),
    });
  }
  return { before, after: sim, calls, turns };
}
