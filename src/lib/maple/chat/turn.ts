import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from "ai";
import { chatProviderOptions, CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_STEPS, CHAT_TIMEOUT, LIMIT_MESSAGE, STEP_PROMPT_LIMIT } from "./caps";
import { costMicro, stepTokens, type ModelPrice, type StepTokens } from "./prices";
import { dashFilter } from "./dashes";
import { contextText, markTailForCache, systemBlocks, usesCacheBreakpoints } from "./prompt";
import { TOOL_APPROVAL } from "./tools";
import { CHAT_FAILED, CHAT_OFF, type ChatData, type ChatMessage } from "./types";

/**
 * One chat turn as a streamed response: the model with the member's tools,
 * the help card the server adds, and the reply saved once it has finished,
 * even when the phone stopped listening halfway. Storage comes in through
 * `deps`, so the route owns the database and a check can run this with a
 * stand-in model.
 */

export { CHAT_FAILED, CHAT_OFF };
export const CHAT_CUT = "This chat got too long to finish that answer. Ask again and it carries on in a new chat.";

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

export type TurnDeps = {
  save: (m: ChatMessage) => Promise<void>;
  record: (u: { step: number; tokens: StepTokens; costMicro: bigint; priceKey: string; finishReason: string | null; generationId: string | null }) => Promise<void>;
  release: () => Promise<void>;
  report: (error: unknown) => void;
  /** Keeps the function alive until the promise settles (next/server's after). */
  waitUntil: (p: Promise<unknown>) => void;
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

export async function chatTurn(opts: {
  model: LanguageModel;
  modelKey: string;
  price: ModelPrice;
  tools: ToolSet;
  viewer: boolean;
  /** She has let the chat see her page (chat_care); `tools` must match. */
  care: boolean;
  messages: ChatMessage[];
  responseId: string;
  crisis: boolean;
  /** Steps the reply already ran before an approval: the cap is per message, not per request. */
  stepsDone?: number;
  deps: TurnDeps;
}): Promise<Response> {
  const { tools, messages, responseId, deps } = opts;
  const stepsDone = opts.stepsDone ?? 0;
  const instructions = systemBlocks({ viewer: opts.viewer, care: opts.care, model: opts.modelKey });
  const breakpoints = usesCacheBreakpoints(opts.modelKey);
  const prefixChars = JSON.stringify([instructions, Object.entries(tools).map(([name, t]) => [name, t.description, (t.inputSchema as { jsonSchema?: unknown }).jsonSchema])]).length;

  const record = (step: number, tokens: StepTokens, finishReason: string | null, generationId: string | null) => {
    const cost = costMicro(opts.modelKey, opts.price, tokens);
    return deps.record({ step: stepsDone + step, tokens, costMicro: cost.micro, priceKey: cost.key, finishReason, generationId }).catch(deps.report);
  };
  let inFlight: { step: number; prompt: number } | null = null;
  let failedStatus: number | null = null;
  let cut = false;
  // Ends the turn: a step sent without its tools would miss the cached prefix, which starts with them.
  const promptTooLong: StopCondition<ToolSet> = ({ steps }) => (cut = lastPrompt(steps) > STEP_PROMPT_LIMIT);

  const result = streamText({
    model: opts.model,
    instructions,
    messages: await convertToModelMessages(messages, {
      tools,
      ignoreIncompleteToolCalls: true,
      convertDataPart: (p) => (p.type === "data-context" ? { type: "text", text: contextText(p.data as ChatData["context"]) } : undefined),
    }),
    tools,
    toolApproval: TOOL_APPROVAL,
    stopWhen: [isStepCount(Math.max(1, CHAT_MAX_STEPS - stepsDone)), promptTooLong],
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    reasoning: "low",
    timeout: CHAT_TIMEOUT,
    providerOptions: chatProviderOptions(opts.price.providers),
    prepareStep: ({ steps, stepNumber, messages: stepMessages }) => {
      inFlight = { step: stepNumber, prompt: Math.max(lastPrompt(steps), roughTokens(prefixChars + JSON.stringify(stepMessages).length)) };
      return breakpoints ? { messages: markTailForCache(stepMessages) } : {};
    },
    onStepEnd: async (step) => {
      inFlight = null;
      const gen = (step.providerMetadata?.gateway as { generationId?: unknown } | undefined)?.generationId;
      await record(step.stepNumber, stepTokens(step.usage), step.finishReason ?? null, typeof gen === "string" ? gen.slice(0, 200) : null);
    },
    // Set, so the SDK's own handler never prints the failed request (it carries the prompt) to the logs.
    onError: ({ error }) => {
      failedStatus = errorStatus(error);
      deps.report(error);
    },
  });

  const stream = createUIMessageStream<ChatMessage>({
    originalMessages: messages,
    generateId: () => responseId,
    onError: friendlyError,
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId: responseId });
      if (opts.crisis) writer.write({ type: "data-help", data: { reason: "crisis" } });
      const reader = toUIMessageStream<ToolSet, ChatMessage>({
        stream: result.stream,
        tools,
        sendStart: false,
        sendFinish: false,
        sendReasoning: true,
        onError: friendlyError,
      }).getReader();
      const dashes = new Map<string, ReturnType<typeof dashFilter>>();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "text-start") dashes.set(value.id, dashFilter());
        if (value.type === "text-delta") {
          const delta = dashes.get(value.id)?.push(value.delta) ?? value.delta;
          if (delta) writer.write({ ...value, delta });
          continue;
        }
        if (value.type === "text-end") {
          const rest = dashes.get(value.id)?.end();
          if (rest) writer.write({ type: "text-delta", id: value.id, delta: rest });
          dashes.delete(value.id);
        }
        writer.write(value);
      }
      const unfinished = inFlight;
      // A 4xx was turned away before the model ran, so there's nothing to count.
      if (unfinished && !(failedStatus !== null && failedStatus >= 400 && failedStatus < 500)) await record(unfinished.step, unfinishedTokens(unfinished.prompt), "unfinished", null);
      const finish = await Promise.resolve(result.finishReason).catch(() => null);
      if (cut && finish === "tool-calls") {
        writer.write({ type: "text-start", id: "cut" });
        writer.write({ type: "text-delta", id: "cut", delta: CHAT_CUT });
        writer.write({ type: "text-end", id: "cut" });
      }
      if (finish === "content-filter" && !opts.crisis) writer.write({ type: "data-help", data: { reason: "refusal" } });
      writer.write({ type: "finish", ...(finish ? { finishReason: finish } : {}) });
    },
    onEnd: async ({ responseMessage }) => {
      try {
        if (responseMessage.parts.length) await deps.save(responseMessage);
      } catch (e) {
        deps.report(e);
      } finally {
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
