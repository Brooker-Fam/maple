import { BATH } from "./lines/bath";
import { CARE } from "./lines/care";
import { DIAPERS } from "./lines/diapers";
import { FEEDS } from "./lines/feeds";
import { MOMENTS } from "./lines/moments";
import { NIGHT } from "./lines/night";
import { NOTES } from "./lines/notes";
import { PUMPING } from "./lines/pumping";
import { SELF } from "./lines/self";
import { SLEEP } from "./lines/sleep";
import { TUMMY } from "./lines/tummy";
import type { Extra } from "./types";

/**
 * Every little extra (types.ts): what a line may follow, for which ages, and
 * for facts where they come from, one file per group in lines/. The rules every
 * line keeps are checked by `pnpm check:maple-whimsy`; the short version: kind
 * to every family (any feeding, any family shape, any day), never advice or a
 * number to measure the baby against, never about sleep anywhere but the
 * baby's own flat, bare space, no emoji, and quiet at night. Every fact was
 * read against its source page, and says no more than that page does.
 */
export const EXTRAS: readonly Extra[] = [...CARE, ...DIAPERS, ...FEEDS, ...PUMPING, ...SLEEP, ...TUMMY, ...BATH, ...MOMENTS, ...NOTES, ...SELF, ...NIGHT];
