import type { Baby } from "./types";

/**
 * How copy names the baby and her mom. Every family but the Brookers gets
 * its words from its own rows: the baby's nickname or first name, pronouns
 * from `sex` ("they" when it isn't set), and the care person's first name.
 * The Brookers' family keeps exactly the words the app has always used,
 * whatever their rows say, so nothing they read changes.
 */

const BROOKERS = 1;

export type Pronoun = "she" | "he" | "they";

export type Voice = {
  /** Mid-sentence: "Maple", "Rowan", "the baby". */
  name: string;
  /** At the start of a sentence: "Maple", "The baby". */
  Name: string;
  /** False while `name` is the "the baby" stand-in. */
  named: boolean;
  pronoun: Pronoun;
  they: string;
  They: string;
  them: string;
  their: string;
  Their: string;
  theirs: string;
  themselves: string;
  /** A verb agreeing with `they`: "is" → "are", "'s" → "'re", "'s been" → "'ve been", "has" → "have", "seems" → "seem". */
  verb: (singular: string) => string;
  /** Her mom's first name ("Mom" when the family has no care page). */
  mom: string;
  /** False when `mom` is the "Mom" stand-in. */
  hasMom: boolean;
};

const FORMS: Record<Pronoun, Pick<Voice, "they" | "They" | "them" | "their" | "Their" | "theirs" | "themselves">> = {
  she: { they: "she", They: "She", them: "her", their: "her", Their: "Her", theirs: "hers", themselves: "herself" },
  he: { they: "he", They: "He", them: "him", their: "his", Their: "His", theirs: "his", themselves: "himself" },
  they: { they: "they", They: "They", them: "them", their: "their", Their: "Their", theirs: "theirs", themselves: "themselves" },
};

const PLURAL_VERBS: Record<string, string> = {
  is: "are",
  "'s": "'re",
  has: "have",
  was: "were",
  does: "do",
  "doesn't": "don't",
  "isn't": "aren't",
  "wasn't": "weren't",
  "hasn't": "haven't",
};

export function pluralVerb(singular: string): string {
  const fixed = PLURAL_VERBS[singular];
  if (fixed) return fixed;
  if (singular.startsWith("'s ")) return `'ve${singular.slice(2)}`;
  const [head, ...rest] = singular.split(" ");
  const base = /(ch|sh|ss|x|z|o)es$/.test(head) ? head.slice(0, -2) : /[^aeiou]ies$/.test(head) ? `${head.slice(0, -3)}y` : head.replace(/s$/, "");
  return [base, ...rest].join(" ");
}

export function pronounFor(sex: Baby["sex"] | string | null | undefined): Pronoun {
  return sex === "female" ? "she" : sex === "male" ? "he" : "they";
}

const UNNAMED = "the baby";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The first word of a name or nickname; "the baby" until there is one ("Baby" is the placeholder before naming). */
export function babyFirstName(baby: Pick<Baby, "name" | "nickname"> | null | undefined): string {
  const first = (baby?.nickname || baby?.name || "").trim().split(/\s+/)[0] ?? "";
  return !first || /^baby$/i.test(first) ? UNNAMED : first;
}

export function makeVoice(opts: { name: string; pronoun: Pronoun; mom?: string | null }): Voice {
  const forms = FORMS[opts.pronoun];
  const mom = opts.mom?.trim().split(/\s+/)[0] || "";
  return {
    name: opts.name,
    Name: cap(opts.name),
    named: opts.name !== UNNAMED,
    pronoun: opts.pronoun,
    ...forms,
    verb: opts.pronoun === "they" ? pluralVerb : (v) => v,
    mom: mom || "Mom",
    hasMom: !!mom,
  };
}

/** The Brookers' words, as the app has always said them. */
export const FAMILY_ONE_VOICE: Voice = makeVoice({ name: "Maple", pronoun: "she", mom: "Brittany" });

/** One family's voice. `mom`: the care person's name (carePersonName), null without a page. */
export function voiceFor(familyId: number, baby: (Pick<Baby, "name" | "nickname"> & { sex?: Baby["sex"] }) | null | undefined, mom?: string | null): Voice {
  if (familyId === BROOKERS) return FAMILY_ONE_VOICE;
  return makeVoice({ name: babyFirstName(baby), pronoun: pronounFor(baby?.sex), mom });
}
