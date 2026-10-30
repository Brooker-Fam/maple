import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { Fam } from "../auth";
import { FeedbackRefused, parseFeedback, sendFeedback } from "../feedback/store";
import { FEEDBACK_MAX_CHARS, FEEDBACK_TOPICS } from "../feedback/types";
import type { Member } from "../types";
import type { ChatToolOutput } from "./types";

/** What the model reads ("Maple's Log", never a bare "Maple", which can be family 1's baby) and what the card shows. */
export const FEEDBACK_SENT = "Sent to the person who makes Maple's Log.";
const SENT_NOTE = "Sent to the person who makes Maple.";

const feedbackInput = z.object({ message: z.string().min(1).max(FEEDBACK_MAX_CHARS), topic: z.enum(FEEDBACK_TOPICS) }).strict();

/**
 * send_feedback: the person's words about Maple itself, for the person who
 * makes it (feedback/store.ts). It waits for a tap on its card
 * (TOOL_APPROVAL), which shows exactly the message stored with the call, and
 * only that stored call runs. `member` and `fam` are the signed-in session's.
 */
export function feedbackTool(member: Pick<Member, "email" | "role">, fam: Fam) {
  return tool<z.infer<typeof feedbackInput>, ChatToolOutput, Record<string, unknown>>({
    description:
      "Send feedback about the Maple's Log app itself to the person who makes it: a problem or bug, something confusing, an idea or a missing feature, or praise. Use it when they ask to pass something along to whoever makes the app, or when they describe a problem with the app and want it reported. message: their feedback in the first person, as they would write it, keeping the details that explain it (what they tapped, what they expected, what happened instead); leave out the baby's and family's names, health details and log contents unless they asked to include them. topic: problem, idea, praise or other. It shows a Send card with exactly that message, and nothing is sent until they tap Send, so call it as soon as you know what to send instead of asking them to confirm first. Never send feedback they didn't ask to send. Not for questions about the baby, logging or health.",
    inputSchema: zodSchema(feedbackInput),
    execute: async (input) => {
      try {
        await sendFeedback(fam, member, parseFeedback({ message: input.message, topic: input.topic }, "chat"));
        return { ok: true, write: true, text: FEEDBACK_SENT, feedback: { sent: true, note: SENT_NOTE } };
      } catch (error) {
        if (!(error instanceof FeedbackRefused)) throw error;
        return { ok: false, write: true, text: `Not sent: ${error.message}`, feedback: { sent: false, note: `Not sent. ${error.message}` } };
      }
    },
    toModelOutput: ({ output }) => ({ type: output.ok ? "text" : "error-text", value: output.text }),
  });
}
