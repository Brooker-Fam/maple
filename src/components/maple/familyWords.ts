import { useMemo } from "react";
import type { MilestoneWords } from "@/lib/maple/milestones";
import type { Baby, MapleState } from "@/lib/maple/types";
import { babyFirstName, makeVoice, pronounFor, type Voice } from "@/lib/maple/voice";
import { useMaple } from "./useMaple";

export { babyFirstName };

const FAMILY_ONE = 1;

/** Whether this is the original family, for legacy feature compatibility. */
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

/** The baby's words always come from the current family's saved profile. */
export function familyBabyWords(state: Pick<MapleState, "family" | "baby">): BabyWords {
  return babyWords(state.baby);
}

/** Who a view-only guest asks to change something, as the server words it for this family (familyInfo). */
export function useAskWho(): string {
  return useMaple().state?.family?.ask ?? "an owner";
}

export function useBabyWords(): BabyWords {
  const { state } = useMaple();
  const baby = state?.baby;
  return useMemo(() => babyWords(baby), [baby]);
}

/** Names and pronouns from the signed-in family's records. */
export function babyVoice(baby: Pick<Baby, "name" | "nickname" | "sex"> | null | undefined, mom?: string | null): Voice {
  return makeVoice({ name: babyFirstName(baby), pronoun: pronounFor(baby?.sex), mom });
}

export function useVoice(): Voice {
  const { state } = useMaple();
  const baby = state?.baby;
  const mom = state?.care?.person.name ?? null;
  return useMemo(() => babyVoice(baby, mom), [baby, mom]);
}

/** Whose milestone presets and words the Moments screens use. */
export function useMilestoneWords(): MilestoneWords {
  const one = useFamilyOne();
  const w = useBabyWords();
  return useMemo(() => ({ familyOne: one, name: w.name }), [one, w.name]);
}
