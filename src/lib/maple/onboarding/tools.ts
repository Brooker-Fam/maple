import { tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import { AnswerError, birthProblem, parseAnswer, skippable, STEP_TITLES, type Proposal, type StepId } from "./steps";

const SKIPPABLE = ["baby_name", "sex", "feeding", "invites", "care", "pediatrician", "notifications"] as const satisfies readonly StepId[];

/**
 * The onboarding chat's tools: one per question, each typed to its field.
 * None writes anything. Each checks the model's value with the same
 * validator the form uses and hands it to the screen as a confirm chip; only
 * the person's tap saves it (POST /api/maple/onboarding). A value that
 * doesn't fit comes back as a result the model can fix.
 */

const CONFIRM = "Shown to them as a chip to tap. Nothing is saved until they tap it.";

function propose<S extends StepId>(step: S, raw: unknown, check?: (value: ReturnType<typeof parseAnswer<S>>) => string | null): Proposal {
  try {
    const value = parseAnswer(step, raw);
    const problem = check?.(value) ?? null;
    if (problem) return { ok: false, text: `${problem} Nothing was proposed; ask them again.` };
    return { ok: true, kind: "answer", step, value, text: CONFIRM };
  } catch (e) {
    if (e instanceof AnswerError) return { ok: false, text: `${e.message} Nothing was proposed; ask them again.` };
    throw e;
  }
}

const toModel = ({ output }: { output: Proposal }) => (output.ok ? { type: "text" as const, value: output.text } : { type: "error-text" as const, value: output.text });

const def = <T extends z.ZodRawShape>(description: string, shape: T, run: (input: z.infer<z.ZodObject<T>>) => Proposal) =>
  tool({ description, inputSchema: zodSchema(z.object(shape)), execute: async (input: z.infer<z.ZodObject<T>>) => run(input), toModelOutput: toModel });

const nullableText = (max: number) => z.string().max(max).nullable().optional();

export function onboardingTools(opts: { tz: string; now: Date }): ToolSet {
  return {
    propose_you: def(
      "The person's first name, and what the baby will call them (Mom, Dad, Mama, Papa, Parent, or their own word).",
      { name: z.string().max(40), role_word: nullableText(20) },
      (i) => propose("you", i)
    ),
    propose_timezone: def(
      "The family's timezone (IANA, like America/Chicago) and units: us (lb, oz, °F) or metric (kg, °C).",
      { timezone: z.string().max(64), units: z.enum(["us", "metric"]) },
      (i) => propose("timezone", i)
    ),
    propose_baby_name: def(
      "The baby's name, and a nickname if they gave one. name null means they haven't picked one yet.",
      { name: nullableText(80), nickname: nullableText(40) },
      (i) => propose("baby_name", i)
    ),
    propose_birth: def(
      "Born: born true, date YYYY-MM-DD and time HH:MM (24-hour, the family's local time; null if they don't know it). Not born yet: born false and the due date in date.",
      { born: z.boolean(), date: z.string().max(10), time: z.string().max(5).nullable().optional() },
      (i) =>
        propose("birth", i.born ? { born: true, date: i.date, time: i.time ?? null } : { born: false, due: i.date }, (v) => birthProblem(v, opts.tz, opts.now))
    ),
    propose_sex: def(
      "The baby's sex, used only to pick the WHO growth chart: girl, boy, or prefer_not.",
      { sex: z.enum(["girl", "boy", "prefer_not"]) },
      (i) => propose("sex", { sex: i.sex === "girl" ? "female" : i.sex === "boy" ? "male" : null })
    ),
    propose_feeding: def(
      "How the baby is fed; any of these can be true.",
      { nursing: z.boolean(), pumping: z.boolean(), formula: z.boolean() },
      (i) => propose("feeding", i)
    ),
    propose_invites: def(
      "People to invite: each a first name and a role, member (can log) or viewer (view only). The app makes a one-time link for each after the tap.",
      { people: z.array(z.object({ name: z.string().max(40), role: z.enum(["member", "viewer"]) })).max(6) },
      (i) => propose("invites", i)
    ),
    propose_care_page: def(
      'The recovery page: "me" when the person typing gave birth and wants it (the app then shows its consent), "later" when it\'s for someone else who will turn it on once they join, "no" for not now.',
      { choice: z.enum(["me", "later", "no"]) },
      // Her consent is the tap on the card the app shows, never the model's word.
      (i) => (i.choice === "me" ? { ok: true, kind: "answer", step: "care", value: { choice: "me" }, text: CONFIRM } : propose("care", i))
    ),
    propose_pediatrician: def(
      "The baby's pediatrician: their name, office phone and after-hours phone, as typed. Any can be null.",
      { name: nullableText(80), phone: nullableText(30), after_hours: nullableText(30) },
      (i) => propose("pediatrician", { name: i.name ?? null, phone: i.phone ?? null, after_hours: i.after_hours ?? null })
    ),
    propose_notifications: def(
      "Whether to open this phone's notification setup after starting the log. This only records a request, not permission or an active subscription.",
      { on: z.boolean() },
      (i) => propose("notifications", i)
    ),
    propose_skip: def(
      "Skip one question for now; it can be answered later in Settings.",
      { step: z.enum(SKIPPABLE) },
      (i): Proposal => (skippable(i.step) ? { ok: true, kind: "skip", step: i.step, text: CONFIRM } : { ok: false, text: `${STEP_TITLES[i.step]} is needed before logging.` })
    ),
    propose_finish: def("Shows the summary with Start logging, once nothing needed is left.", {}, () => ({ ok: true, kind: "finish", text: CONFIRM })),
    show_help: def("Shows the help card: 911, call or text 988, and the National Maternal Mental Health Hotline.", {}, () => ({ ok: true, kind: "help", text: "The help card is showing under your reply." })),
  };
}
