import { alertGatewayCredit } from "../usage-alerts/gateway";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type FinishReason,
  type InferUIMessageChunk,
  type LanguageModel,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from "ai";
import { chatProviderOptions, CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_STEPS, CHAT_RETRIES, CHAT_RETRY_MIN_MS, CHAT_TIMEOUT, LIMIT_MESSAGE, STEP_PROMPT_LIMIT } from "./caps";
import type { ToolCopy } from "../mcp-tools";
import { costMicro, stepTokens, type ModelPrice, type StepTokens } from "./prices";
import { dashFilter } from "./dashes";
import { outputShows } from "./display";
import { contextText, markTailForCache, systemBlocks, usesCacheBreakpoints, withMemoryLines, type ChatPartLimits } from "./prompt";
import { TOOL_APPROVAL } from "./tools";
import { definitionTokens, notLoadedOutput, TOOL_ORDER, toolDisclosure } from "./tool-groups";
import { CHAT_FAILED, CHAT_NO_ANSWER, CHAT_OFF, type ChatData, type ChatMessage, type ChatToolOutput } from "./types";
import { inputTokens, modelWindow } from "./window";
import { SEARCH_FINISH, withoutSpend, type SearchSpend, type WebSearchOutput } from "./web-search";

/**
 * One chat turn as a streamed response: the model with the member's tools,
 * the help card the server adds, and the reply saved once it has finished,
 * even when the phone stopped listening halfway. Storage comes in through
 * `deps`, so the route owns the database and a check can run this with a
 * stand-in model.
 *
 * A reply never ends in silence. Each step's chunks wait on the server until
 * the step shows or runs something; a model call that times out, fails or
 * comes back with nothing before then is asked once more (CHAT_RETRIES),
 * from the steps that did finish, and the phone never sees the one that
 * didn't. When that can't help, the reply's last line says the answer
 * stopped, and whether anything may have been saved.
 */

export { CHAT_FAILED, CHAT_NO_ANSWER, CHAT_OFF };
export const CHAT_CUT = "That answer got too long to finish. Try asking again.";

/** A question's answers are canonical server data, including on a turn that is still waiting for another answer. */
export function questionReply(message: ChatMessage, opts: { notice?: string; crisis?: boolean } = {}): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream<ChatMessage>({
      originalMessages: [message],
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: message.id });
        if (opts.crisis) writer.write({ type: "data-help", data: { reason: "crisis" } });
        for (const p of message.parts) {
          if (p.type === "tool-ask_user" && "state" in p && p.state === "output-available" && "toolCallId" in p && "output" in p) {
            writer.write({ type: "tool-output-available", toolCallId: p.toolCallId as string, output: p.output });
          }
        }
        if (opts.notice) {
          writer.write({ type: "text-start", id: "question-limit" });
          writer.write({ type: "text-delta", id: "question-limit", delta: opts.notice });
          writer.write({ type: "text-end", id: "question-limit" });
        }
        writer.write({ type: "finish", finishReason: "stop" });
      },
    }),
    headers: { "Cache-Control": "no-store" },
  });
}

/** An error's HTTP status, or the last attempt's once the SDK's retries ran out. */
export function errorStatus(error: unknown): number | null {
  const e = error as { statusCode?: unknown; lastError?: { statusCode?: unknown } | null } | null;
  const status = typeof e?.statusCode === "number" ? e.statusCode : e?.lastError?.statusCode;
  return typeof status === "number" ? status : null;
}

/** What the phone shows for an error mid-answer: never the error itself, which can quote the request. */
export function friendlyError(error: unknown): string {
  const status = errorStatus(error);
  if (status === 402 || status === 429) return LIMIT_MESSAGE;
  if (status === 401 || status === 403) return CHAT_OFF;
  return CHAT_FAILED;
}

/** Worth asking the model again: a dropped or garbled stream, a timeout, the provider's own failure. Never a refusal, a limit or a bad request. */
export function retryableError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 408 || status >= 500;
}

/**
 * The reply's last line when its answer stopped and wasn't asked again: a
 * limit or the chat being off says so; otherwise whether anything may have
 * been saved (`wrote`: a write's result, a tool that failed or never
 * answered), since only "nothing was saved" makes sending it again safe.
 */
export function stoppedLine(error: unknown, wrote: boolean): string {
  const status = errorStatus(error);
  if (status === 402 || status === 429) return LIMIT_MESSAGE;
  if (status === 401 || status === 403) return CHAT_OFF;
  return wrote ? CHAT_FAILED : CHAT_NO_ANSWER;
}

export type TurnDeps = {
  save: (m: ChatMessage) => Promise<void>;
  record: (u: { step: number; tokens: StepTokens; costMicro: bigint; priceKey: string; finishReason: string | null; generationId: string | null }) => Promise<void>;
  release: () => Promise<void>;
  report: (error: unknown) => void;
  /** Keeps the function alive until the promise settles (next/server's after). */
  waitUntil: (p: Promise<unknown>) => void;
  lifecycle?: (event: "chat_started" | "chat_completed" | "chat_failed") => void;
};

const lastPrompt = (steps: StepResult<ToolSet>[]) => (steps.length ? stepTokens(steps[steps.length - 1].usage).prompt : 0);

const roughTokens = (chars: number) => Math.ceil(chars / 3);

/**
 * A step that never reported its usage (it timed out, or the stream failed
 * partway) can still be billed, so the budgets count it as its whole prompt
 * written to the cache plus the most output a step can have.
 */
function unfinishedTokens(prompt: number): StepTokens {
  return { prompt, fresh: 0, cacheRead: 0, cacheWrite: prompt, output: CHAT_MAX_OUTPUT_TOKENS, reasoning: 0 };
}

type Chunk = InferUIMessageChunk<ChatMessage>;

/** What the route reports, by name only, when a model call ran out of time or came back with nothing to show. */
const flagged = (name: "chat_timeout" | "chat_no_answer") => Object.assign(new Error(name), { name });

export async function chatTurn(opts: {
  model: LanguageModel;
  modelKey: string;
  price: ModelPrice;
  /** Every tool this person may have (chatTools); each step sends the core and the groups it needs (tool-groups.ts). */
  tools: ToolSet;
  viewer: boolean;
  /** Her page is open to this chat (chatCareOpen); `tools` must match. */
  care: boolean;
  /** What an owner set for this person on her page, when it isn't everything (systemBlocks). */
  page?: "view" | "hidden";
  /** What an owner turned down for this person (access.ts parts), when anything is: `tools` must match (chatLimits). */
  partLimits?: ChatPartLimits;
  /** A shared chat's people (shared.ts), for its prompt lines; `herConsent`: she let the chat see her page at all. */
  shared?: { people: string[]; herConsent: boolean };
  /** The family's words: the instructions must match the tools' (both from one ToolCopy). */
  copy: ToolCopy;
  messages: ChatMessage[];
  responseId: string;
  crisis: boolean;
  /** Steps the reply already ran before an approval: the cap is per message, not per request. */
  stepsDone?: number;
  /** Question answers cannot extend the message's model-step budget. Approval-only completion keeps its existing final reporting step. */
  questionContinuation?: boolean;
  resolveImages?: (messages: ChatMessage[]) => Promise<ChatMessage[]>;
  /** The family memories' block (memoryPromptBlock), read onto the newest user message, and this thread's messages from before their last Forget, which the model no longer reads. */
  memories?: { block: string; forgotten: ReadonlySet<string> } | null;
  /** The turn's time limits, and how much of them a second try needs left: the route's are CHAT_TIMEOUT and CHAT_RETRY_MIN_MS; a check passes shorter ones. */
  limits?: { timeout: { totalMs: number; stepMs: number; toolMs: number }; retryMinMs: number };
  deps: TurnDeps;
}): Promise<Response> {
  const { messages, responseId, deps } = opts;
  const stepsDone = opts.stepsDone ?? 0;
  const limits = opts.limits ?? { timeout: CHAT_TIMEOUT, retryMinMs: CHAT_RETRY_MIN_MS };
  // Continuations share one budget. A pending question must never buy another model step at the boundary.
  if (opts.questionContinuation && stepsDone >= CHAT_MAX_STEPS) {
    const last = messages[messages.length - 1];
    const completed: ChatMessage = { ...last, id: responseId, role: "assistant", parts: [...last.parts, { type: "text", text: CHAT_CUT }] };
    try { await deps.save(completed); } finally { await deps.release(); }
    return questionReply(completed, { notice: CHAT_CUT, crisis: opts.crisis });
  }
  const window = modelWindow(messages, opts.memories?.forgotten);
  const hasImages = window.some((message) => message.parts.some((part) => part.type === "file"));
  const instructions = systemBlocks({ viewer: opts.viewer, care: opts.care, ...(opts.page ? { page: opts.page } : {}), ...(opts.partLimits ? { limits: opts.partLimits } : {}), ...(opts.shared ? { shared: opts.shared } : {}), model: opts.modelKey, copy: opts.copy, images: hasImages });
  const breakpoints = usesCacheBreakpoints(opts.modelKey);
  const maxSteps = Math.max(1, CHAT_MAX_STEPS - stepsDone);
  // The person's tools plus load_tools: all of them for history, execution and the stream; each step sends its selection.
  const disclosure = toolDisclosure(opts.tools, { window, vo: opts.copy.v, lastStep: maxSteps - 1 });
  const { tools } = disclosure;
  const instructionTokens = roughTokens(JSON.stringify(instructions).length);
  const prefixTokens = (names: readonly string[]) => instructionTokens + definitionTokens(disclosure.sizes, names);

  const record = (step: number, tokens: StepTokens, finishReason: string | null, generationId: string | null) => {
    const cost = costMicro(opts.modelKey, opts.price, tokens);
    return deps.record({ step: stepsDone + step, tokens, costMicro: cost.micro, priceKey: cost.key, finishReason, generationId }).catch(deps.report);
  };
  /** A web search's own request and fee (web-search.ts), counted against the same budgets as the step that asked for it. */
  const recordSearch = (step: number, s: SearchSpend) =>
    /^\d{1,15}$/.test(s.costMicro)
      ? deps.record({ step: stepsDone + step, tokens: s.tokens, costMicro: BigInt(s.costMicro), priceKey: s.priceKey, finishReason: SEARCH_FINISH, generationId: s.generationId }).catch(deps.report)
      : Promise.resolve();
  // Each try's own: the step in flight, the error that ended it, and whether it stopped on a long prompt.
  let inFlight: { step: number; prompt: number } | null = null;
  let attemptError: unknown = undefined;
  let failedStatus: number | null = null;
  let cut = false;
  // Ends the turn: a step sent without its tools would miss the cached prefix, which starts with them.
  const promptTooLong: StopCondition<ToolSet> = ({ steps }) => (cut = lastPrompt(steps) > STEP_PROMPT_LIMIT);

  let failed = false;
  let completed = false;
  if (!opts.resolveImages && hasImages) throw new Error("chat_images_unavailable");
  const modelMessages = withMemoryLines(opts.resolveImages ? await opts.resolveImages(window) : window, opts.memories?.block);
  const input = await convertToModelMessages(modelMessages, {
    tools,
    ignoreIncompleteToolCalls: true,
    convertDataPart: (p) => (p.type === "data-context" ? { type: "text", text: contextText(p.data as ChatData["context"]) } : undefined),
  });
  deps.lifecycle?.("chat_started");

  // One deadline for the whole turn, so a second try fits in the route's time and the thread's lease, as the first did.
  const deadline = Date.now() + limits.timeout.totalMs;
  // The steps that finished and stay, across tries: a second try starts after them, with their results.
  const kept: StepResult<ToolSet>[] = [];
  // Model calls this request has made, kept or not: each counts toward maxSteps and gets its own usage row.
  let calls = 0;
  /**
   * One try: the model from where the kept steps left off. `again`: a second
   * try, routed to the fastest of the same providers. `onToolStart`: a tool is
   * about to run (the SDK runs a step's tools once its model call is over).
   */
  const ask = (again: boolean, onToolStart: (toolCallId: string) => void) => {
    const prior = [...kept];
    const first = calls;
    const left = Math.max(1, deadline - Date.now());
    const done = prior.flatMap((s) => s.response.messages);
    attemptError = undefined;
    failedStatus = null;
    cut = false;
    return streamText({
      model: opts.model,
      instructions,
      messages: done.length ? [...input, ...done] : input,
      tools,
      // Core first, then the groups, always in this order, so the part of the prefix that didn't change stays cached.
      toolOrder: [...TOOL_ORDER],
      toolApproval: TOOL_APPROVAL,
      // Never repairs: notes a call to a tool the step didn't send, so the next step has it.
      repairToolCall: disclosure.repair,
      stopWhen: [isStepCount(maxSteps - first), promptTooLong],
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
      reasoning: "low",
      timeout: { totalMs: left, stepMs: Math.min(limits.timeout.stepMs, left), toolMs: limits.timeout.toolMs },
      providerOptions: chatProviderOptions(opts.price.providers, { fastest: again }),
      prepareStep: ({ steps, stepNumber, messages: stepMessages }) => {
        // Steps count across tries, so the step cap, the last step and the usage rows mean the same on a second try.
        const at = first + stepNumber;
        calls = at + 1;
        const so = [...prior, ...steps];
        const selected = disclosure.select(at, so).active;
        // The last step answers: no question that would need another.
        const active = at >= maxSteps - 1 ? selected.filter((name) => name !== "ask_user") : selected;
        const explained = disclosure.explain(stepMessages);
        inFlight = { step: at, prompt: Math.max(lastPrompt(so), prefixTokens(active) + inputTokens(explained)) };
        const sent = breakpoints ? markTailForCache(explained) : explained;
        return { activeTools: active, ...(sent !== stepMessages ? { messages: sent } : {}) };
      },
      onStepEnd: async (step) => {
        inFlight = null;
        kept.push(step);
        const at = first + step.stepNumber;
        const gen = (step.providerMetadata?.gateway as { generationId?: unknown } | undefined)?.generationId;
        await record(at, stepTokens(step.usage), step.finishReason ?? null, typeof gen === "string" ? gen.slice(0, 200) : null);
        for (const r of step.toolResults) {
          const spend = (r.output as WebSearchOutput | undefined)?.spend;
          if (spend) await recordSearch(at, spend);
        }
      },
      onToolExecutionStart: ({ toolCall }) => onToolStart(toolCall.toolCallId),
      // Set, so the SDK's own handler never prints the failed request (it carries the prompt) to the logs.
      onError: ({ error }) => {
        attemptError = error;
        failedStatus = errorStatus(error);
        deps.waitUntil(alertGatewayCredit(error));
        deps.report(error);
      },
    });
  };

  const stream = createUIMessageStream<ChatMessage>({
    originalMessages: messages,
    generateId: () => responseId,
    onError: (error) => { failed = true; return friendlyError(error); },
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId: responseId });
      if (opts.crisis) writer.write({ type: "data-help", data: { reason: "crisis" } });
      // Replace the phone's raw choice/text with the validated result before streaming the continuation.
      const previous = messages[messages.length - 1];
      if (previous?.id === responseId && previous.role === "assistant") {
        for (const p of previous.parts) {
          if (p.type === "tool-ask_user" && "state" in p && p.state === "output-available" && "toolCallId" in p && "output" in p) {
            writer.write({ type: "tool-output-available", toolCallId: p.toolCallId as string, output: p.output });
          }
        }
      }
      // What the reply shows and may have done so far, across tries.
      let said = false; // words the phone shows
      let card = false; // anything else it shows: a receipt, a chart, an error, a question, a tap to answer
      let waiting = false; // it ends on a question or a tap
      let wrote = false; // a write's result, or a tool that failed: something may have been saved
      const started = new Set<string>(); // calls whose tool began to run (onToolStart): from then on it may save something
      const answered = new Set<string>(); // calls whose result came back
      let early = false; // a tap's tool ran (or was kept) before the model was asked: a second try would run it again
      let stopped = false;
      let finish: FinishReason | null = null;
      let line: string | null = null;
      for (let tries = 0; ; tries++) {
        // The step's chunks, held until it shows or runs something; null once they go straight to the phone.
        let held: Chunk[] | null = null;
        let stepped = false;
        let inStep = false;
        let ended = false; // the held step finished
        let errored = false;
        let aborted = false;
        const dashes = new Map<string, ReturnType<typeof dashFilter>>();
        const flush = () => {
          for (const c of held ?? []) writer.write(c);
          held = null;
        };
        /** `shows`: the chunk shows or runs something, so its step can't be taken back now. */
        const send = (chunk: Chunk, shows = false) => {
          if (shows) flush();
          if (held) held.push(chunk);
          else writer.write(chunk);
        };
        const keptBefore = kept.length;
        // From the moment a tool starts it may save something, so its step goes to the phone then and stays.
        const result = ask(tries > 0, (id) => {
          started.add(id);
          flush();
        });
        const reader = toUIMessageStream<ToolSet, ChatMessage>({
          stream: result.stream,
          tools,
          sendStart: false,
          sendFinish: false,
          sendReasoning: true,
          onError: friendlyError,
        }).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Decided once the call is over: asked again, or the reply's last line says what happened.
          if (value.type === "error") { errored = true; continue; }
          // A time limit (CHAT_TIMEOUT): nothing else aborts the server's own call.
          if (value.type === "abort") { aborted = true; continue; }
          if (value.type === "start-step") {
            flush();
            stepped = inStep = true;
            ended = false;
            held = [value];
            continue;
          }
          if (value.type === "finish-step") {
            inStep = false;
            if (held) { held.push(value); ended = true; }
            else writer.write(value);
            continue;
          }
          if (!stepped) early = true;
          if (value.type === "text-start") dashes.set(value.id, dashFilter());
          if (value.type === "text-delta") {
            const delta = dashes.get(value.id)?.push(value.delta) ?? value.delta;
            if (delta) {
              const shows = delta.trim() !== "";
              said ||= shows;
              send({ ...value, delta }, shows);
            }
            continue;
          }
          if (value.type === "text-end") {
            const rest = dashes.get(value.id)?.end();
            dashes.delete(value.id);
            if (rest) {
              const shows = rest.trim() !== "";
              said ||= shows;
              send({ type: "text-delta", id: value.id, delta: rest }, shows);
            }
            send(value);
            continue;
          }
          // A call to a tool its step didn't send ran nothing, and the next step can make it again: no error card for it.
          if (value.type === "tool-input-error" || value.type === "tool-output-error") {
            const missed = disclosure.missOf(value.toolCallId);
            if (missed) {
              answered.add(value.toolCallId);
              const input = value.type === "tool-input-error" && value.input && typeof value.input === "object" ? value.input : {};
              send(
                value.type === "tool-input-error"
                  ? { type: "tool-input-available", toolCallId: value.toolCallId, toolName: missed, input }
                  : { type: "tool-output-available", toolCallId: value.toolCallId, output: notLoadedOutput(missed) },
                true
              );
              continue;
            }
          }
          switch (value.type) {
            case "tool-input-available":
              // A question waits for the person. Any other call runs only once the model's call is over (onToolStart), so until then its step can still be taken back.
              if (value.toolName === "ask_user") card = waiting = true;
              send(value, value.toolName === "ask_user" || started.has(value.toolCallId));
              continue;
            case "tool-approval-request":
              card = waiting = true;
              send(value, true);
              continue;
            case "tool-output-available": {
              answered.add(value.toolCallId);
              const o = value.output as Partial<ChatToolOutput> | undefined;
              if (!(o?.ok === true && o.write === false)) wrote = true;
              card ||= outputShows(value.output);
              // A search's spend is for the budgets alone: the phone and the saved chat never get it.
              send({ ...value, output: withoutSpend(value.output) }, true);
              continue;
            }
            case "tool-output-error":
              answered.add(value.toolCallId);
              wrote = card = true;
              send(value, true);
              continue;
            case "tool-output-denied":
              answered.add(value.toolCallId);
              card = true;
              send(value, true);
              continue;
            case "tool-input-error":
              card = true;
              send(value, true);
              continue;
          }
          // Reasoning, a call's input as it streams, sources: they wait with their step.
          send(value);
        }
        // A tool that started and never answered may have saved something, whatever order its chunks came in (the SDK
        // starts it from inside the stream, perhaps before this loop read its call): its step stays, and isn't asked again.
        const unanswered = [...started].some((id) => !answered.has(id));
        if (unanswered) flush();
        // The model's last step had already finished, wanting no more tools: a limit after that only cut the stream's close.
        const over = !inStep && held === null && (kept.slice(keptBefore).at(-1)?.finishReason ?? "tool-calls") !== "tool-calls";
        const failure = (errored || aborted) && !over;
        // The last call's work never reached the phone: its step showed and ran nothing, or it failed before a step began.
        const blank = !unanswered && (held !== null || (failure && !inStep));
        const unfinished = inFlight as { step: number; prompt: number } | null;
        inFlight = null;
        const status = failedStatus as number | null;
        // A 4xx was turned away before the model ran, so there's nothing to count.
        if (unfinished && !(status !== null && status >= 400 && status < 500)) await record(unfinished.step, unfinishedTokens(unfinished.prompt), "unfinished", null);
        finish = (await Promise.resolve(result.finishReason).catch(() => null)) ?? (over ? (kept.at(-1)?.finishReason ?? null) : null);
        if (aborted && !over) deps.report(flagged("chat_timeout"));
        else if (blank && !failure && finish !== "content-filter") deps.report(flagged("chat_no_answer"));
        // A held step that finished showed nothing, so a second try starts without it.
        if (held && ended) kept.pop();
        const again =
          blank && !early && !waiting && !cut && finish !== "content-filter" && tries < CHAT_RETRIES && calls < maxSteps &&
          deadline - Date.now() >= limits.retryMinMs && (!errored || retryableError(attemptError));
        // What a try held back showed and ran nothing (its calls never started), so it's dropped either way.
        if (again) continue;
        stopped = failure;
        const unsure = wrote || unanswered;
        if (failure && !waiting) line = stoppedLine(attemptError, unsure);
        else if (blank && !said && !card && finish !== "content-filter") line = stoppedLine(null, unsure);
        break;
      }
      failed ||= stopped;
      if (cut && finish === "tool-calls") {
        writer.write({ type: "text-start", id: "cut" });
        writer.write({ type: "text-delta", id: "cut", delta: CHAT_CUT });
        writer.write({ type: "text-end", id: "cut" });
      }
      if (finish === "content-filter" && !opts.crisis) writer.write({ type: "data-help", data: { reason: "refusal" } });
      if (line) {
        writer.write({ type: "text-start", id: "stopped" });
        writer.write({ type: "text-delta", id: "stopped", delta: line });
        writer.write({ type: "text-end", id: "stopped" });
      }
      completed = !failed && !line && (finish === "stop" || finish === "tool-calls" || finish === "content-filter" || finish === "length");
      writer.write({ type: "finish", finishReason: failed || line ? "error" : (finish ?? "other") });
    },
    onEnd: async ({ responseMessage, isAborted }) => {
      try {
        if (responseMessage.parts.length) await deps.save(responseMessage);
      } catch (e) {
        failed = true;
        deps.report(e);
      } finally {
        deps.lifecycle?.(completed && !failed && !isAborted ? "chat_completed" : "chat_failed");
        await deps.release();
      }
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: { "Cache-Control": "no-store" },
    // The phone can lock or lose signal mid-answer: this copy is read to the end
    // regardless, so the tools finish and the whole reply is saved.
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
