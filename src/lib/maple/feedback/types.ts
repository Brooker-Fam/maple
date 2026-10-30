/**
 * What the app, the chat and the admin page share about feedback
 * (feedback/store.ts). No server imports: the app bundles this file.
 *
 * `via`: where it was written: the chat's Send card ("chat"), Settings →
 * Send feedback ("app"), or the one-time question on Today ("prompt").
 * `rating`: the answer to that question; the other two never set it.
 */

export const FEEDBACK_MAX_CHARS = 2000;

export const FEEDBACK_VIA = ["chat", "app", "prompt"] as const;
export type FeedbackVia = (typeof FEEDBACK_VIA)[number];

export const FEEDBACK_TOPICS = ["problem", "idea", "praise", "other"] as const;
export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];

export const FEEDBACK_RATINGS = ["well", "okay", "not_well"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const TOPIC_LABEL: Record<FeedbackTopic, string> = { problem: "Problem", idea: "Idea", praise: "Praise", other: "Feedback" };
export const RATING_LABEL: Record<FeedbackRating, string> = { well: "Really well", okay: "Okay", not_well: "Not well" };
export const VIA_LABEL: Record<FeedbackVia, string> = { chat: "the chat", app: "Settings", prompt: "the question on Today" };

/** What the app says once feedback went, or didn't. */
export const FEEDBACK_THANKS = "Sent. Thank you.";
export const FEEDBACK_NOT_SENT = "That didn't send. Try again in a moment.";

/** The question Today asks once (FeedbackPrompt.tsx), with RATING_LABEL as its answers. */
export const FEEDBACK_QUESTION = "How is Maple working for you?";

/** Where feedback goes, as every place that sends it says: `replyable` when the sender's account has an email address. */
export function feedbackDestination(replyable: boolean): string {
  return replyable ? "It goes to the person who makes Maple, with your email address so they can reply." : "It goes to the person who makes Maple.";
}

/** A member id that's an email address the person who makes Maple can reply to: never the shared admin login or an invite-link guest. */
export const replyableMember = (id: string): boolean => id !== "admin" && !id.startsWith("invite:") && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id);

/** GET /api/maple/feedback: whether Today asks this person its question now. */
export type FeedbackAsk = { ask: boolean; replyable: boolean };
