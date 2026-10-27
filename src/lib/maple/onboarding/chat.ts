import { alertGatewayCredit } from "../usage-alerts/gateway";
import { createUIMessageStream, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { capsVerdict, chatProviderOptions, CHAT_TIMEOUT, type Usage } from "../chat/caps";
import { mentionsCrisis } from "../chat/crisis";
import { storable, withCrisisHelp } from "../chat/messages";
import { scrub } from "../chat/post";
import { costMicro, priceFor, stepTokens, type ModelPrice, type StepTokens } from "../chat/prices";
import { chatBudget, countMessage, recordUsage, usageSince } from "../chat/store";
import { errorStatus, friendlyError } from "../chat/turn";
import { CHAT_MAX_CHARS, CHAT_OFF, CHAT_TERMS_NEEDED } from "../chat/types";
import { chatConsent } from "../consent";
import type { FamilyCtx } from "../family";
import { dayBounds, dayKey, startOfDay } from "../time";
import { StoreUnavailable } from "../store";
import type { Member } from "../types";
import { onboardingSystem } from "./prompt";
import {
  ONBOARDING_HISTORY,
  ONBOARDING_MAX_OUTPUT_TOKENS,
  ONBOARDING_STEPS_PER_MESSAGE,
  type OnboardingMessage,
  type OnboardingRefusal,
  type OnboardingView,
} from "./steps";
import { claimModelSteps, readView, returnModelSteps } from "./store";
import { onboardingTools } from "./tools";

/**
 * One message to the onboarding chat, from the raw body to a streamed answer
 * or a refusal. The chat's model, ZDR options, crisis check, caps and usage
 * rows apply unchanged; the tools only propose values (tools.ts), so the
 * conversation itself saves nothing and the phone sends back its last few
 * text messages. What the family has answered comes from the server's rows
 * every turn (statusBlock), never from the phone. Storage comes in through
 * `deps`, so a check can run every path against a stand-in model.
 */

export const ONBOARDING_THREAD = "onboarding";
export const FORM_NEXT = "The chat has done its part. The questions carry on here, with buttons.";
export const SETUP_DONE = "This log is already set up.";

export type OnboardingChatDeps = {
  consent: () => Promise<{ terms: boolean }>;
  view: () => Promise<OnboardingView>;
  usage: (day: string, dayStart: Date, monthStart: Date) => Promise<Usage>;
  budget: () => Promise<{ day: bigint; month: bigint }>;
  claim: (n: number) => Promise<number | null>;
  unclaim: (n: number) => Promise<void>;
  countMessage: (day: string) => Promise<void>;
  record: (u: { messageId: string; step: number; tokens: StepTokens; costMicro: bigint; priceKey: string; finishReason: string | null; generationId: string | null }) => Promise<void>;
  model: LanguageModel;
  modelKey: string;
  price: ModelPrice | null;
  now: Date;
  newId: () => string;
  /** Gets every error already scrubbed, so whatever it logs carries no message text. */
  report: (error: Error) => void;
  waitUntil: (p: Promise<unknown>) => void;
};

export function familyChatDeps(
  ctx: FamilyCtx,
  member: Member,
  opts: Pick<OnboardingChatDeps, "model" | "modelKey" | "now" | "newId" | "report" | "waitUntil">
): OnboardingChatDeps {
  return {
    ...opts,
    consent: () => chatConsent(ctx, member),
    view: () => readView(ctx),
    usage: (day, dayStart, monthStart) => usageSince(ctx, member.email, day, dayStart, monthStart),
    budget: () => chatBudget(ctx, opts.now),
    claim: (n) => claimModelSteps(ctx, n),
    unclaim: (n) => returnModelSteps(ctx, n),
    countMessage: (day) => countMessage(ctx, member.email, day),
    record: (u) => recordUsage(ctx, { ...u, member: member.email, threadId: ONBOARDING_THREAD, model: opts.modelKey }),
    price: priceFor(opts.modelKey),
  };
}

const CAPS_TZ = "UTC";

export class HistoryError extends Error {}

type Turn = { role: "user" | "assistant"; text: string };

export function readHistory(raw: unknown): Turn[] {
  const list = (raw as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list) || !list.length || list.length > 4 * ONBOARDING_HISTORY) throw new HistoryError("Expected a message");
  const turns = list.slice(-ONBOARDING_HISTORY).flatMap((m): Turn[] => {
    const r = m as { role?: unknown; text?: unknown } | null;
    if (!r || (r.role !== "user" && r.role !== "assistant") || typeof r.text !== "string") throw new HistoryError("Expected a message");
    const text = storable(r.text).trim();
    if (text.length > (r.role === "user" ? CHAT_MAX_CHARS : 2 * CHAT_MAX_CHARS)) throw new HistoryError(`That's over ${CHAT_MAX_CHARS.toLocaleString("en-US")} characters. Try a shorter message.`);
    return text ? [{ role: r.role, text }] : [];
  });
  if (turns[turns.length - 1]?.role !== "user") throw new HistoryError("Type a message first.");
  return turns;
}

function roughLast(raw: unknown): string {
  const list = (raw as { messages?: unknown } | null)?.messages;
  const last = Array.isArray(list) ? (list[list.length - 1] as { role?: unknown; text?: unknown } | null) : null;
  return last?.role === "user" && typeof last.text === "string" ? last.text.slice(0, 10 * CHAT_MAX_CHARS) : "";
}

const reply = (body: OnboardingRefusal | { error: string }, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The crisis check reads the raw message first, so a cap or a store error still answers with the help card. */
export async function answerOnboardingChat(body: unknown, member: Member, deps: OnboardingChatDeps): Promise<Response> {
  const report = (e: unknown) => deps.report(scrub(e));
  const names = await deps
    .view()
    .then((v) => [v.values.baby?.name, v.values.baby?.nickname])
    .catch(() => []);
  const crisis = mentionsCrisis(roughLast(body), names);
  const res = await turn(body, member, crisis, { ...deps, report }).catch((e: unknown) => {
    if (e instanceof StoreUnavailable) return reply({ error: "Maple's log is offline right now" }, 503);
    report(e);
    return reply({ error: "Something went wrong" }, 500);
  });
  return crisis ? withCrisisHelp(res) : res;
}

async function turn(body: unknown, member: Member, crisis: boolean, deps: Omit<OnboardingChatDeps, "report"> & { report: (e: unknown) => void }): Promise<Response> {
  let history: Turn[];
  try {
    history = readHistory(body);
  } catch (e) {
    if (e instanceof HistoryError) return reply({ error: e.message }, 400);
    throw e;
  }
  const price = deps.price;
  if (!price) {
    deps.report(Object.assign(new Error(), { name: "chat_model_unpriced" }));
    return reply({ error: CHAT_OFF, code: "off" }, 503);
  }
  const view = await deps.view();
  if (view.status !== "onboarding" || !view.owner) return reply({ error: SETUP_DONE, code: "done" }, 409);
  if (!(await deps.consent()).terms) return reply({ error: CHAT_TERMS_NEEDED, code: "terms" }, 403);

  const tz = view.values.timezone.timezone;
  // The caps keep UTC's day: the owner can change the family's zone while setting up, and a new zone mustn't start a new day.
  const today = dayKey(deps.now, CAPS_TZ);
  const usage = await deps.usage(today, dayBounds(today, CAPS_TZ)[0], startOfDay(`${today.slice(0, 8)}01`, CAPS_TZ));
  const limit = capsVerdict(usage, { role: member.role, newMessage: true, budget: await deps.budget() });
  if (limit) return reply({ error: limit, code: "limit" }, 429);
  if ((await deps.claim(ONBOARDING_STEPS_PER_MESSAGE)) === null) return reply({ error: FORM_NEXT, code: "form" }, 429);
  await deps.countMessage(today);

  const responseId = deps.newId();
  const tools = onboardingTools({ tz, now: deps.now });
  const messages: ModelMessage[] = history.map((t) => ({ role: t.role, content: t.text }));
  return stream({ ...deps, price }, { tools, messages, view, responseId, crisis });
}

function unfinishedTokens(prompt: number): StepTokens {
  return { prompt, fresh: 0, cacheRead: 0, cacheWrite: prompt, output: ONBOARDING_MAX_OUTPUT_TOKENS, reasoning: 0 };
}

function stream(
  deps: Omit<OnboardingChatDeps, "report" | "price"> & { price: ModelPrice; report: (e: unknown) => void },
  t: { tools: ToolSet; messages: ModelMessage[]; view: OnboardingView; responseId: string; crisis: boolean }
): Response {
  const instructions = onboardingSystem(t.view, deps.now, deps.modelKey);
  const prefixChars = JSON.stringify([instructions, Object.keys(t.tools), t.messages]).length;
  let stepsRun = 0;
  let inFlight: { step: number; prompt: number } | null = null;
  let failedStatus: number | null = null;
  const record = (step: number, tokens: StepTokens, finishReason: string | null, generationId: string | null) => {
    const cost = costMicro(deps.modelKey, deps.price, tokens);
    return deps.record({ messageId: t.responseId, step, tokens, costMicro: cost.micro, priceKey: cost.key, finishReason, generationId }).catch(deps.report);
  };

  const result = streamText({
    model: deps.model,
    instructions,
    messages: t.messages,
    tools: t.tools,
    stopWhen: isStepCount(ONBOARDING_STEPS_PER_MESSAGE),
    maxOutputTokens: ONBOARDING_MAX_OUTPUT_TOKENS,
    reasoning: "low",
    timeout: CHAT_TIMEOUT,
    providerOptions: chatProviderOptions(deps.price.providers),
    prepareStep: ({ stepNumber, messages }) => {
      stepsRun = stepNumber + 1;
      inFlight = { step: stepNumber, prompt: Math.ceil((prefixChars + JSON.stringify(messages).length) / 3) };
      return {};
    },
    onStepEnd: async (step) => {
      inFlight = null;
      const gen = (step.providerMetadata?.gateway as { generationId?: unknown } | undefined)?.generationId;
      await record(step.stepNumber, stepTokens(step.usage), step.finishReason ?? null, typeof gen === "string" ? gen.slice(0, 200) : null);
    },
    // Set, so the SDK's own handler never prints the failed request (it carries the prompt) to the logs.
    onError: ({ error }) => {
      failedStatus = errorStatus(error);
      deps.waitUntil(alertGatewayCredit(error));
      deps.report(error);
    },
  });

  const ui = createUIMessageStream<OnboardingMessage>({
    generateId: () => t.responseId,
    onError: friendlyError,
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId: t.responseId });
      if (t.crisis) writer.write({ type: "data-help", data: { reason: "crisis" } });
      const reader = toUIMessageStream<ToolSet, OnboardingMessage>({ stream: result.stream, tools: t.tools, sendStart: false, sendFinish: false, onError: friendlyError }).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
      }
      const unfinished = inFlight as { step: number; prompt: number } | null;
      if (unfinished && !(failedStatus !== null && failedStatus >= 400 && failedStatus < 500)) await record(unfinished.step, unfinishedTokens(unfinished.prompt), "unfinished", null);
      const finish = await Promise.resolve(result.finishReason).catch(() => null);
      if (finish === "content-filter" && !t.crisis) writer.write({ type: "data-help", data: { reason: "refusal" } });
      writer.write({ type: "finish", ...(finish ? { finishReason: finish } : {}) });
    },
    onEnd: async () => {
      await deps.unclaim(ONBOARDING_STEPS_PER_MESSAGE - stepsRun).catch(deps.report);
    },
  });

  return createUIMessageStreamResponse({
    stream: ui,
    headers: { "Cache-Control": "no-store" },
    consumeSseStream: ({ stream: copy }) => {
      deps.waitUntil(
        (async () => {
          const r = copy.getReader();
          while (!(await r.read()).done);
        })().catch(deps.report)
      );
    },
  });
}
