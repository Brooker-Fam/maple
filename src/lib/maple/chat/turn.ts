import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type StepResult,
  type ToolSet,
} from "ai";
import { chatProviderOptions, CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_STEPS, CHAT_TIMEOUT, LIMIT_MESSAGE, STEP_PROMPT_LIMIT } from "./caps";
import { costMicro, stepTokens, type ModelPrice, type StepTokens } from "./prices";
import { markTailForCache, systemBlocks } from "./prompt";
import { TOOL_APPROVAL } from "./tools";
import type { ChatMessage } from "./types";

/**
 * One chat turn as a streamed response: the model with the member's tools,
 * the help card the server adds, and the reply saved once it has finished,
 * even when the phone stopped listening halfway. Storage comes in through
 * `deps`, so the route owns the database and a check can run this with a
 * stand-in model.
 */

export const CHAT_OFF = "The chat isn't available right now. Logging works as usual.";
export const CHAT_FAILED = "Something went wrong, so the answer stopped. Check Today before trying again, so nothing is logged twice.";

/** What the phone shows for an error mid-answer: never the error itself, which can quote the request. */
export function friendlyError(error: unknown): string {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
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

export async function chatTurn(opts: {
  model: LanguageModel;
  modelKey: string;
  price: ModelPrice;
  tools: ToolSet;
  viewer: boolean;
  messages: ChatMessage[];
  responseId: string;
  crisis: boolean;
  deps: TurnDeps;
}): Promise<Response> {
  const { tools, messages, responseId, deps } = opts;

  const result = streamText({
    model: opts.model,
    instructions: systemBlocks(opts.viewer),
    messages: await convertToModelMessages(messages, {
      tools,
      ignoreIncompleteToolCalls: true,
      convertDataPart: (p) => (p.type === "data-context" ? { type: "text", text: `[App] ${(p.data as { line: string }).line}` } : undefined),
    }),
    tools,
    toolApproval: TOOL_APPROVAL,
    stopWhen: isStepCount(CHAT_MAX_STEPS),
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    reasoning: "low",
    timeout: CHAT_TIMEOUT,
    providerOptions: chatProviderOptions(),
    prepareStep: ({ steps, messages: stepMessages }) => ({
      messages: markTailForCache(stepMessages),
      ...(lastPrompt(steps) > STEP_PROMPT_LIMIT ? { toolChoice: "none" as const } : {}),
    }),
    onStepEnd: async (step) => {
      const tokens = stepTokens(step.usage);
      const cost = costMicro(opts.modelKey, opts.price, tokens);
      const gen = (step.providerMetadata?.gateway as { generationId?: unknown } | undefined)?.generationId;
      await deps
        .record({
          step: step.stepNumber,
          tokens,
          costMicro: cost.micro,
          priceKey: cost.key,
          finishReason: step.finishReason ?? null,
          generationId: typeof gen === "string" ? gen.slice(0, 200) : null,
        })
        .catch(deps.report);
    },
    // Set, so the SDK's own handler never prints the failed request (it carries the prompt) to the logs.
    onError: ({ error }) => deps.report(error),
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
      }
      const finish = await Promise.resolve(result.finishReason).catch(() => null);
      if (finish === "content-filter" && !opts.crisis) {
        const steps = await Promise.resolve(result.steps).catch(() => []);
        if (!steps.some((s) => s.text.trim())) writer.write({ type: "data-help", data: { reason: "refusal" } });
      }
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
