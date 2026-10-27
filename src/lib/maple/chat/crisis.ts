/**
 * Words about harming oneself or someone else, checked on the server before
 * the model runs: a match always puts the help card (911, 988, the maternal
 * line) under the reply, whatever the model says. It leans toward showing
 * the card: a false match costs a card, a missed one could cost far more.
 * Someone telling about their partner ("she said she wants to hurt
 * herself") counts the same. Harm to others needs a person as its subject
 * ("I keep thinking I'll hurt her"), so "did the shot hurt her?" stays an
 * ordinary question, and baby talk ("she took the whole bottle", "she
 * doesn't want to wake up") stays out.
 */

const HARM = "(hurt|hurting|harm|harming|kill|killing|shake|shaking|smother|smothering|drown|drowning|suffocate|suffocating|hit|hitting)";
const PEOPLE = "her|him|them|maple|the baby|my baby|our baby|the kid|my kid|my daughter|my son|my (husband|wife|partner)|someone|somebody|anyone";
const ON_PURPOSE_WHO = "her|him|them|the baby|my baby|maple";

const PILLS = "(pills|meds|medicines?|medications?|tablets|painkillers|sleeping pills)";
const THEY = "(he|she|they|my (husband|wife|partner))";

function phrases(someone: string, onPurposeWho: string): RegExp[] {
  return [
    /\bsuicid(e|al)\b/,
    /\bkill(ing)? my ?self\b/,
    /\bkms\b/,
    /\bend(ing)? (my (own )?life|it all)\b/,
    /\b(want to|wanna|going to|gonna|thinking (of|about)|could) (just )?end (things|everything)\b/,
    /\btak(e|ing) my (own )?life\b/,
    /\b(want to|wants to|wanted to|wanting to|wanna|going to|gonna) die\b/,
    /\bwish i (was|were|could be) (dead|gone)\b/,
    /\bwish i (had never been|was never|were never|wasn't) born\b/,
    /\b(want to|wants to|wanna|wish i could|wish i would) (just )?disappear\b/,
    /\b(wish|want|hope) (i|to)\b[^.?!]{0,30}\b(never|not|wouldn't|didn't|don't) wake up\b/,
    /\bi (want to|wanna|wish i could) (just )?(go to )?sleep forever\b/,
    /\bbetter off (dead|without (me|him|them|her(?=$|[.,!?;])))/,
    /\bbetter off (if|when) (i|he|she|they)('m|'s|'re| was| were| am| is| are)? ?(gone|dead|not (here|around))\b/,
    /\bno (reason|point) (to|in) (live|living|go on|going on)\b/,
    /\b(can't|cannot) (go on|do this anymore|keep going)\b/,
    /\b(can't|cannot) (take|handle) (it|this) ?(anymore|any ?more|any longer)\b/,
    /\b(don't|do not) want to (live|be alive|be here|wake up|exist)\b/,
    /\b(doesn't|does not) want to (live|be alive|be here anymore|exist)\b/,
    /\b(thinking|talking|talked|thought|think|thinks) (about|of) (ending it|ending things|dying|not being here)\b/,
    /\b(hurt|hurting|harm|harming|cut|cutting|hit|hitting|punish|punishing) my ?self\b/,
    /\b(kill|killing|hurt|hurting|harm|harming) (herself|himself|themselves|themself)\b/,
    /\bself[- ]?harm/,
    /\boverdos(e|ing) on purpose\b/,
    /\b(i|i've|he|she|they|he's|she's|they've)\b[^.?!]{0,15}\boverdos(ed|ing)\b/,
    /\b(took|taken|take|taking) an overdose\b/,
    new RegExp(`\\b(took|take|taking|swallowed) (all|too many|a bunch|a whole bottle|the whole bottle)\\b[^.?!]{0,20}\\b${PILLS}\\b`),
    /\bi('m| am) not safe\b/,
    /\bi (don't|do not) feel safe\b/,
    new RegExp(`\\b(i|i'm|i am|i'll|i'd|i've)\\b[^.?!]{0,40}\\b${HARM} ${someone}\\b`),
    new RegExp(`\\b${THEY}\\b[^.?!]{0,40}\\b(wants? to|wanted to|wanna|going to|gonna|'d|'ll|thoughts? of|thinking (of|about)|urges? to) ${HARM} ${someone}\\b`),
    new RegExp(`\\b(makes|made|making) me want to ${HARM}\\b`),
    new RegExp(`\\b(thoughts?|urges?|images?) (of|about) ${HARM}\\b`),
    new RegExp(`\\b(drop|dropping|throw|throwing|hurt|hurting|harm|harming|shake|shaking|smother|drown) ${onPurposeWho}\\b[^.?!]{0,10}\\bon purpose\\b`),
    /\b(picturing|imagining|images? of|visions? of|see myself|seeing myself)\b[^.?!]{0,30}\b(drown|drowning|drowned|throw|throwing|threw|drop|dropping|dropped|hurt|hurting|smother|smothering|shake|shaking|falling|dying|dead)\b/,
    /\b(scary|intrusive|dark) thoughts?\b/,
  ];
}

export function normalizeForCrisis(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\b(dont|doesnt|cant|im|ive|wont|didnt|wouldnt)\b/g, (w) => ({ dont: "don't", doesnt: "doesn't", cant: "can't", im: "i'm", ive: "i've", wont: "won't", didnt: "didn't", wouldnt: "wouldn't" })[w] ?? w)
    .replace(/\s+/g, " ");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The baby's own names (first name, nickname), lowercased and escaped, as words a sentence can name them by. */
function babyNames(names: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = normalizeForCrisis(raw ?? "").trim();
    if (!n || n.length > 40 || /^(the )?baby$/.test(n)) continue;
    out.add(escape(n));
    const first = n.split(" ")[0];
    if (first) out.add(escape(first));
  }
  return [...out];
}

const BASE = phrases(`(${PEOPLE})`, `(${ON_PURPOSE_WHO})`);

/** `names`: the family's baby's name and nickname, so "I'll hurt Leo" counts as "I'll hurt the baby" does. */
export function mentionsCrisis(text: string, names: readonly (string | null | undefined)[] = []): boolean {
  const t = normalizeForCrisis(text);
  const own = babyNames(names);
  const list = own.length ? phrases(`(${PEOPLE}|${own.join("|")})`, `(${ON_PURPOSE_WHO}|${own.join("|")})`) : BASE;
  return list.some((p) => p.test(t));
}
