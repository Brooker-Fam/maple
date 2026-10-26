import type { Role } from "../types";

/**
 * The in-app chat's limits. Every one fails closed: when a count or a sum
 * can't be read, the chat says no and logging carries on as usual.
 */

export const CHAT_MODEL_DEFAULT = "anthropic/claude-haiku-5.5";

export function chatModel(env: Record<string, string | undefined> = process.env): string {
  return env.MAPLE_CHAT_MODEL?.trim() || CHAT_MODEL_DEFAULT;
}

/** Applied to every chat request, so no call can reach a provider that keeps prompts or trains on them. */
export const GATEWAY_PRIVACY = { zeroDataRetention: true, disallowPromptTraining: true } as const;

export function chatProviderOptions() {
  return { gateway: { tags: ["maple-chat"], ...GATEWAY_PRIVACY } };
}

export const CHAT_MAX_STEPS = 6;
export const CHAT_MAX_OUTPUT_TOKENS = 1500;
export const CHAT_TIMEOUT = { totalMs: 55_000, stepMs: 25_000, toolMs: 15_000 };

/** A thread this long starts over in a new one, which keeps prompts well under the 100K-token price step. */
export const THREAD_MAX_USER_MESSAGES = 40;
export const THREAD_MAX_PROMPT_TOKENS = 60_000;
/** A step whose prompt passed this ends the turn, even with its tool results unread. */
export const STEP_PROMPT_LIMIT = 60_000;

export const DAILY_MESSAGES: Record<Role, number> = { owner: 60, member: 60, viewer: 20 };

export const DAILY_BUDGET_DEFAULT = BigInt(500_000);
export const MONTHLY_BUDGET_DEFAULT = BigInt(5_000_000);

/** A budget in micro-dollars from the environment: unset is the default, anything that isn't a whole number is 0. */
export function budgetFrom(raw: string | undefined, fallback: bigint): bigint {
  const v = raw?.trim();
  if (!v) return fallback;
  return /^\d{1,15}$/.test(v) ? BigInt(v) : BigInt(0);
}

export function budgets(env: Record<string, string | undefined> = process.env): { day: bigint; month: bigint } {
  return {
    day: budgetFrom(env.MAPLE_CHAT_DAILY_BUDGET_MICRO, DAILY_BUDGET_DEFAULT),
    month: budgetFrom(env.MAPLE_CHAT_MONTHLY_BUDGET_MICRO, MONTHLY_BUDGET_DEFAULT),
  };
}

export const LIMIT_MESSAGE = "That's the chat's limit for today. Logging works as usual.";
export const MONTH_MESSAGE = "That's the chat's limit for this month. Logging works as usual.";

export type Usage = { mine: number; day: bigint; month: bigint };

/** Why this turn can't run, or null. `newMessage`: a new user message (an approval's continuation isn't one). */
export function capsVerdict(u: Usage, opts: { role: Role; newMessage: boolean; budget: { day: bigint; month: bigint } }): string | null {
  if (u.month >= opts.budget.month) return MONTH_MESSAGE;
  if (u.day >= opts.budget.day) return LIMIT_MESSAGE;
  if (opts.newMessage && u.mine >= DAILY_MESSAGES[opts.role]) return LIMIT_MESSAGE;
  return null;
}

/** Whether a thread has to roll over to a new one before taking another message. */
export function threadFull(t: { userMessages: number; lastPrompt: number }): boolean {
  return t.userMessages >= THREAD_MAX_USER_MESSAGES || t.lastPrompt >= THREAD_MAX_PROMPT_TOKENS;
}
