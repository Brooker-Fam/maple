import { useMemo } from "react";
import { FAMILY_ONE_MILESTONE_WORDS, type MilestoneWords } from "@/lib/maple/milestones";
import type { Baby, MapleState } from "@/lib/maple/types";
import { babyFirstName, FAMILY_ONE_VOICE, makeVoice, pronounFor, type Voice } from "@/lib/maple/voice";
import { useMaple } from "./useMaple";

export { babyFirstName };

const FAMILY_ONE = 1;

/** The Brookers' log, which keeps its own words and presets whatever its rows say (MapleState.family). */
export const isFamilyOne = (state: Pick<MapleState, "family"> | null | undefined): boolean => state?.family?.id === FAMILY_ONE;

export function useFamilyOne(): boolean {
  return isFamilyOne(useMaple().state);
}

/**
 * The baby's first name and pronouns, for copy. The keys are the male forms
 * because each one has a single job (he/him/his), where "her" has two. With
 * no sex set, the name stands in for every pronoun ("Is Sam on the Left?",
 * "Sam's diaper").
 */
export type BabyWords = {
  name: string;
  Name: string;
  he: string;
  He: string;
  him: string;
  his: string;
  His: string;
  /** "she's": she is, or she has. */
  hes: string;
  Hes: string;
};

type Forms = Pick<BabyWords, "he" | "him" | "his" | "hes">;

const SHE: Forms = { he: "she", him: "her", his: "her", hes: "she's" };
const HE: Forms = { he: "he", him: "him", his: "his", hes: "he's" };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function babyWords(baby: Pick<Baby, "name" | "nickname" | "sex"> | null | undefined): BabyWords {
  const name = babyFirstName(baby);
  const pronoun = pronounFor(baby?.sex);
  const f = pronoun === "she" ? SHE : pronoun === "he" ? HE : { he: name, him: name, his: `${name}'s`, hes: `${name}'s` };
  return { name, Name: cap(name), ...f, He: cap(f.he), His: cap(f.his), Hes: cap(f.hes) };
}

const FAMILY_ONE_WORDS: BabyWords = babyWords({ name: "Maple", nickname: null, sex: "female" });

/** The baby's words for a state snapshot: family 1's are fixed, whatever its rows say. */
export function familyBabyWords(state: Pick<MapleState, "family" | "baby">): BabyWords {
  return isFamilyOne(state) ? FAMILY_ONE_WORDS : babyWords(state.baby);
}

/** Who a view-only guest asks to change something, as the server words it for this family (familyInfo). */
export function useAskWho(): string {
  return useMaple().state?.family?.ask ?? "an owner";
}

export function useBabyWords(): BabyWords {
  const { state } = useMaple();
  const one = isFamilyOne(state);
  const baby = state?.baby;
  return useMemo(() => (one ? FAMILY_ONE_WORDS : babyWords(baby)), [one, baby]);
}

/** One family's voice from its rows; family 1's is always FAMILY_ONE_VOICE, as the server's is. */
export function babyVoice(baby: Pick<Baby, "name" | "nickname" | "sex"> | null | undefined, mom?: string | null, familyOne = false): Voice {
  if (familyOne) return FAMILY_ONE_VOICE;
  return makeVoice({ name: babyFirstName(baby), pronoun: pronounFor(baby?.sex), mom });
}

export function useVoice(): Voice {
  const { state } = useMaple();
  const one = isFamilyOne(state);
  const baby = state?.baby;
  const mom = state?.care?.person.name ?? null;
  return useMemo(() => babyVoice(baby, mom, one), [baby, mom, one]);
}

/** Whose milestone presets and words the Moments screens use. */
export function useMilestoneWords(): MilestoneWords {
  const one = useFamilyOne();
  const w = useBabyWords();
  return useMemo(() => (one ? FAMILY_ONE_MILESTONE_WORDS : { familyOne: false, name: w.name }), [one, w.name]);
}
