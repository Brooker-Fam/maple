import type { Extra } from "../types";

/**
 * Feeds. A "feed" line suits any feed (nursing, a bottle of either milk, milk
 * at the breast by an SNS or a syringe), so it names the breast only alongside
 * the bottle; "nursing" lines follow a nursing feed and "bottle" lines a bottle.
 * Whoever logs a feed may not be the one who gave it, so the nursing lines
 * cheer the feed and the team, never "your body". A `milk` line is true of
 * that milk only; none compares milks or ways of feeding, and none says how
 * much or how often.
 */
export const FEEDS: readonly Extra[] = [
  // ── Any feed ────────────────────────────────────────────────────────────
  { id: "feed-joke-five-stars", kind: "joke", topics: ["feed"], text: "Fed, and hopefully burped. Five stars." },
  { id: "feed-joke-satisfied", kind: "joke", topics: ["feed"], text: "Feed done. One satisfied customer." },
  { id: "feed-joke-burp-pending", kind: "joke", topics: ["feed"], text: "Feed logged. Burp pending." },
  { id: "feed-joke-table", kind: "joke", topics: ["feed"], text: "Feed logged. Table for one, cleared." },
  { id: "feed-joke-refills", kind: "joke", topics: ["feed"], text: "Feed logged. Refills are on the house." },
  { id: "feed-joke-burp-cloth", kind: "joke", topics: ["feed"], text: "Feed done. Burp cloth, please." },
  { id: "feed-joke-milk-mustache", kind: "joke", topics: ["feed"], text: "Feed done. Milk mustache optional." },
  { id: "feed-joke-critic", kind: "joke", topics: ["feed"], text: "Feed logged. The critic seems pleased." },
  { id: "feed-joke-review", kind: "joke", topics: ["feed"], text: "Feed done. The review is in, and it's a burp." },
  { id: "feed-cheer-every-feed", kind: "cheer", topics: ["feed"], text: "Every feed counts, and so do you." },
  { id: "feed-cheer-keeping-going", kind: "cheer", topics: ["feed"], text: "Feed logged. You're keeping {him} going." },
  { id: "feed-cheer-with-care", kind: "cheer", topics: ["feed"], text: "Fed with care. Well done." },
  { id: "feed-cheer-every-way", kind: "cheer", topics: ["feed"], text: "Every way of feeding is a way of caring." },
  { id: "feed-cheer-another-bit", kind: "cheer", topics: ["feed"], text: "Another feed in the log, and another bit of love." },
  { id: "feed-cheer-breath", kind: "cheer", topics: ["feed"], text: "Feed done. Take a breath. You've earned it." },
  { id: "feed-cheer-love-served", kind: "cheer", topics: ["feed"], text: "Feed done. Love, served." },
  { id: "feed-cheer-teamwork", kind: "cheer", topics: ["feed"], text: "Fed and logged. Great teamwork." },
  {
    id: "feed-fact-no-burp",
    kind: "fact",
    topics: ["feed"],
    text: "Fun fact: no baby burps every time. Even champion burpers skip one.",
    source: "https://www.healthychildren.org/English/ages-stages/baby/feeding-nutrition/Pages/baby-burping-hiccups-and-spit-up.aspx",
  },
  {
    id: "feed-fact-swallowed-air",
    kind: "fact",
    topics: ["feed"],
    text: "Fun fact: babies tend to swallow some air while they feed. A burp helps let it out.",
    source: "https://kidshealth.org/en/parents/burping.html",
  },
  {
    id: "feed-fact-close-focus",
    kind: "fact",
    topics: ["feed"],
    ages: [0, 61],
    text: "Fun fact: newborns see best up close, at about the distance to your face during a feed.",
    source: "https://www.healthychildren.org/English/ages-stages/baby/Pages/Babys-Vision-Development.aspx",
  },
  {
    id: "feed-fact-rooting",
    kind: "fact",
    topics: ["feed"],
    ages: [0, 120],
    text: "Fun fact: the rooting reflex helps babies find the breast or bottle. A touch by the mouth sets it off.",
    source: "https://www.stanfordchildrens.org/en/topic/default?id=newborn-reflexes-90-P02630",
  },
  {
    id: "feed-fact-sweet",
    kind: "fact",
    topics: ["feed"],
    ages: [0, 365],
    text: "Fun fact: babies are born preferring sweet tastes over sour or bitter ones.",
    source: "https://www.stanfordchildrens.org/en/topic/default?id=newborn-senses-90-P02631",
  },
  {
    id: "feed-fact-taste-buds",
    kind: "fact",
    topics: ["feed"],
    text: "Fun fact: taste buds begin forming in the womb, around the ninth week of pregnancy.",
    source: "https://my.clevelandclinic.org/health/articles/7247-fetal-development-stages-of-growth",
  },
  {
    id: "feed-fact-womb-tasting",
    kind: "fact",
    topics: ["feed"],
    text: "Fun fact: before birth, babies may taste the amniotic fluid, and even touch their toes.",
    source: "https://kidshealth.org/en/parents/babyslideshow.html",
  },

  // ── Nursing ─────────────────────────────────────────────────────────────
  { id: "nursing-joke-chef", kind: "joke", topics: ["nursing"], text: "Feed done. {He} sends compliments to the chef." },
  { id: "nursing-joke-regular", kind: "joke", topics: ["nursing"], text: "Nursing logged. One very happy regular." },
  { id: "nursing-joke-room-service", kind: "joke", topics: ["nursing"], text: "Nursing logged. Room service, with a view." },
  { id: "nursing-joke-latched", kind: "joke", topics: ["nursing"], text: "Latched, sipped, satisfied. Logged." },
  { id: "nursing-joke-sides", kind: "joke", topics: ["nursing"], text: "Nursing done. Left, right, or both: all counted." },
  { id: "nursing-joke-booth", kind: "joke", topics: ["nursing"], text: "Nursing logged. Best booth in the house." },
  { id: "nursing-joke-reservation", kind: "joke", topics: ["nursing"], text: "Nursing logged. No reservation needed." },
  { id: "nursing-cheer-teamwork", kind: "cheer", topics: ["nursing"], text: "Nursing logged. Great teamwork, all around." },
  { id: "nursing-cheer-feeder", kind: "cheer", topics: ["nursing"], text: "Nursing done. Here's to the one doing the feeding." },
  { id: "nursing-cheer-close", kind: "cheer", topics: ["nursing"], text: "Nursing logged. A quiet, close kind of care." },
  { id: "nursing-cheer-together", kind: "cheer", topics: ["nursing"], text: "Nursing logged. Learning together, one feed at a time." },
  { id: "nursing-cheer-sidelines", kind: "cheer", topics: ["nursing"], text: "Nursing logged. Support from the sidelines counts, too." },

  // ── Bottles ─────────────────────────────────────────────────────────────
  { id: "bottle-joke-burp-loading", kind: "joke", topics: ["bottle"], text: "Bottle done. Somewhere, a burp is loading." },
  { id: "bottle-joke-dish-duty", kind: "joke", topics: ["bottle"], text: "Bottle logged. Dish duty, incoming." },
  { id: "bottle-joke-tasting-menu", kind: "joke", topics: ["bottle"], text: "Bottle done. The tasting menu was a hit." },
  { id: "bottle-joke-no-tipping", kind: "joke", topics: ["bottle"], text: "Bottle done. Full service, no tipping required." },
  { id: "bottle-joke-sip-sip", kind: "joke", topics: ["bottle"], text: "Bottle logged. Sip, sip, hooray." },
  { id: "bottle-joke-barista", kind: "joke", topics: ["bottle"], text: "Bottle logged. The house barista strikes again." },
  { id: "bottle-cheer-bonding", kind: "cheer", topics: ["bottle"], text: "Bottle logged. Feeding is bonding, whoever holds the bottle." },
  { id: "bottle-cheer-cozy-hold", kind: "cheer", topics: ["bottle"], text: "Bottle done. Steady hands, cozy hold." },
  { id: "bottle-cheer-lovingly", kind: "cheer", topics: ["bottle"], text: "Bottle logged. Another feed, lovingly given." },
  { id: "bottle-cheer-little-care", kind: "cheer", topics: ["bottle"], text: "Bottle logged. Every bottle is a little bit of care." },
  { id: "bottle-cheer-breastmilk-teamwork", kind: "cheer", topics: ["bottle"], milk: "breastmilk", text: "Breast milk bottle done. Teamwork, from start to finish." },
  { id: "bottle-cheer-breastmilk-saved", kind: "cheer", topics: ["bottle"], milk: "breastmilk", text: "Breast milk bottle logged. Saved up, served with care." },
  { id: "bottle-joke-formula-scoop", kind: "joke", topics: ["bottle"], milk: "formula", text: "Formula bottle logged. Scoop, shake, serve. Nailed it." },
  { id: "bottle-cheer-formula-mixed", kind: "cheer", topics: ["bottle"], milk: "formula", text: "Formula bottle done. Mixed with care, given with love." },
];
