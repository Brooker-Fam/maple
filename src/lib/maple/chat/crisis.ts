/**
 * Words about harming oneself or someone else, checked on the server before
 * the model runs: a match always puts the help card (911, 988, the maternal
 * line) under the reply, whatever the model says. It leans toward showing
 * the card: a false match costs a card, a missed one could cost far more.
 * Harm to others needs the person as its subject ("I keep thinking I'll
 * hurt her"), so "did the shot hurt her?" stays an ordinary question.
 */

const HARM = "(hurt|hurting|harm|harming|kill|killing|shake|shaking|smother|smothering|drown|drowning|suffocate|suffocating|hit|hitting)";
const SOMEONE = "(her|him|them|maple|the baby|my baby|our baby|the kid|my kid|my daughter|my son|my (husband|wife|partner)|someone|somebody|anyone)";

const PHRASES: RegExp[] = [
  /\bsuicid(e|al)\b/,
  /\bkill(ing)? my ?self\b/,
  /\bend(ing)? (my (own )?life|it all)\b/,
  /\btak(e|ing) my (own )?life\b/,
  /\b(want to|wanna|wanted to|going to|gonna) die\b/,
  /\bwish i (was|were|could be) (dead|gone)\b/,
  /\bwish i (had never been|was never|were never|wasn't) born\b/,
  /\bbetter off (dead|without me)\b/,
  /\bno (reason|point) (to|in) (live|living|go on|going on)\b/,
  /\b(can't|cannot) (go on|do this anymore|keep going)\b/,
  /\bdon't want to (live|be alive|be here anymore|wake up)\b/,
  /\b(hurt|hurting|harm|harming|cut|cutting|hit|hitting|punish|punishing) my ?self\b/,
  /\bself[- ]?harm/,
  /\boverdos(e|ing) on purpose\b/,
  new RegExp(`\\b(i|i'm|i am|i'll|i'd|i've)\\b[^.?!]{0,40}\\b${HARM} ${SOMEONE}\\b`),
  new RegExp(`\\b(makes|made|making) me want to ${HARM}\\b`),
  new RegExp(`\\b(thoughts?|urges?|images?) (of|about) ${HARM}\\b`),
  /\b(scary|intrusive|dark) thoughts?\b/,
];

export function normalizeForCrisis(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\b(dont|cant|im|ive|wont)\b/g, (w) => ({ dont: "don't", cant: "can't", im: "i'm", ive: "i've", wont: "won't" })[w] ?? w)
    .replace(/\s+/g, " ");
}

export function mentionsCrisis(text: string): boolean {
  const t = normalizeForCrisis(text);
  return PHRASES.some((p) => p.test(t));
}
