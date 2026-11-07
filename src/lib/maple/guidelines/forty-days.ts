/**
 * The first forty days: one short note a day on the care person's page, from
 * the birth (day 1) to day 40, drawn from The First Forty Days: The Essential
 * Art of Nourishing the New Mother, by Heng Ou with Amely Greeven and Marisa
 * Belger (Stewart, Tabori & Chang, an Abrams imprint, 2016; ISBN
 * 978-1-61769-183-6), and the traditions it gathers. Each note has words for
 * her ("you") and for whoever else opens her page (how to help), its sources,
 * the date its words were last checked against them (`reviewed`), and
 * `needsReview` until a person has signed off on it.
 *
 * What the book is, for these notes: Heng Ou learned zuo yuezi, "sitting the
 * month", from her aunt, and carries it into forty days to match the six weeks
 * medicine calls the postpartum period. Its recurring themes are rest,
 * warmth, warm soupy food made by others, a circle of help (her "village"),
 * protection from too many visitors, and the mother as the one everyone
 * forgets once the baby arrives; Chapter 6 is "Filling Your Cup: What to Eat"
 * and the Afterword "Beyond the First Forty Days". It says it isn't a medical
 * book, and much of it is tradition or Chinese medicine (no cold food or
 * drink, no hair washing, staying in bed), so:
 *
 * Rules (scripts/maple-forty-days-check.ts holds them):
 * - The book's ideas are paraphrased in our own words and credited to it
 *   (basis "book"), never quoted at length. Nothing says the book prescribes
 *   a ceremony, or that its customs prevent anything.
 * - Comfort, not rules: no "should", "must" or "need to"; no food is ruled
 *   out (cold water, fruit, salads and ice packs stay fine); never bed rest or
 *   skipped showers. Rest always comes with short walks (ACOG: the weeks
 *   after birth and long periods of not moving both raise the risk of clots).
 * - Anything about her health follows ACOG, the WHO, the CDC, the AAP, the
 *   NHS or MedlinePlus and links to it (basis "source" or "both"); every
 *   worrying sign says to call her OB, as the rest of her page does.
 * - Nothing suggests an herb, a supplement, a tonic, alcohol, a medicine or a
 *   dose; FORTY_DAYS_ABOUT's last paragraph alone names them, to say who to
 *   ask first.
 * - A hot drink or bowl is only ever for when someone else holds the baby, or
 *   set down out of the baby's reach (CAPT: it can scald even 15 minutes after
 *   it's made). Warmth is hers: the baby gets one more layer than an adult,
 *   never a warm room or extra bundling (AAP: overheating raises SIDS risk).
 * - "Many cultures", never "every culture": forty is a common number, not one
 *   shared tradition (zuo yuezi is about a month, la cuarentena forty days).
 * - No family's names: helpers' words take the care person's name from Voice.
 *
 * Sources were read on 2026-11-07: the publisher's page and the book's
 * Introduction and first chapters, ACOG Committee Opinion 736 and its FAQs on
 * exercise after pregnancy, blood clots, breastfeeding and postpartum
 * depression, WHO's 2022 postnatal care recommendations, the NHS on
 * breastfeeding and diet, MedlinePlus on going home after a C-section, the
 * CDC on food safety and on vaccines for family and caregivers, the AAP on
 * cocooning a newborn and on safe sleep, the Child Accident Prevention Trust
 * on scalds, Wong and Fisher's 2009 review of confinement and mood, and,
 * for the caution paragraph, the CDC on alcohol and breastfeeding, the USDA's
 * table of how much alcohol cooking leaves, and LactMed on herbs and bleeding.
 * Recheck them when this file changes.
 */
import type { Voice } from "../voice";

/** The window many traditions keep for a new mother's rest, in days from the birth (day 1 is the birth day). */
export const FORTY_DAYS = 40;

export type FortyDaysSource = { label: string; url: string };

export const FORTY_DAYS_BOOK: FortyDaysSource = {
  label: "The First Forty Days, by Heng Ou",
  url: "https://www.abramsbooks.com/product/first-forty-days_9781617691836/",
};

const ACOG_736: FortyDaysSource = {
  label: "ACOG: optimizing postpartum care",
  url: "https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2018/05/optimizing-postpartum-care",
};
const ACOG_EXERCISE: FortyDaysSource = { label: "ACOG: exercise after pregnancy", url: "https://www.acog.org/womens-health/faqs/exercise-after-pregnancy" };
const ACOG_CLOTS: FortyDaysSource = { label: "ACOG: preventing blood clots", url: "https://www.acog.org/womens-health/faqs/preventing-deep-vein-thrombosis" };
const ACOG_PPD: FortyDaysSource = { label: "ACOG: postpartum depression", url: "https://www.acog.org/womens-health/faqs/postpartum-depression" };
const WHO_POSTNATAL: FortyDaysSource = { label: "WHO: a positive postnatal experience", url: "https://www.who.int/publications/i/item/9789240045989" };
const NHS_DIET: FortyDaysSource = { label: "NHS: breastfeeding and diet", url: "https://www.nhs.uk/baby/breastfeeding-and-bottle-feeding/breastfeeding-and-lifestyle/diet/" };
const MEDLINEPLUS_CSECTION: FortyDaysSource = { label: "MedlinePlus: going home after a C-section", url: "https://medlineplus.gov/ency/patientinstructions/000624.htm" };
const CDC_FOOD_SAFETY: FortyDaysSource = { label: "CDC: four steps to food safety", url: "https://www.cdc.gov/food-safety/prevention/index.html" };
const CDC_CAREGIVER_VACCINES: FortyDaysSource = { label: "CDC: vaccines for family and caregivers", url: "https://www.cdc.gov/vaccines-pregnancy/about/vaccines-family-caregivers.html" };
const AAP_COCOON: FortyDaysSource = {
  label: "AAP: how to cocoon a newborn",
  url: "https://www.healthychildren.org/English/safety-prevention/immunizations/Pages/How-to-Cocoon-a-Newborn-Only-an-E-Mail-Away.aspx",
};
const AAP_SAFE_SLEEP: FortyDaysSource = { label: "AAP: safe sleep", url: "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/a-parents-guide-to-safe-sleep.aspx" };
export const CAPT_SCALDS: FortyDaysSource = { label: "Child Accident Prevention Trust: burns and scalds", url: "https://www.capt.org.uk/burns-and-scalds" };
const CONFINEMENT_REVIEW: FortyDaysSource = { label: "Wong and Fisher, 2009: the month of rest and mood", url: "https://pubmed.ncbi.nlm.nih.gov/19135261/" };

export type FortyDaysStageId = "week-one" | "settling" | "widening" | "fortieth";
export type FortyDaysStage = { id: FortyDaysStageId; from: number; to: number; title: string };

/** Days 1 to 40 in four stretches; each day reads its stretch's notes in turn (forty-days.ts). */
export const FORTY_DAY_STAGES: readonly FortyDaysStage[] = [
  { id: "week-one", from: 1, to: 7, title: "The first week" },
  { id: "settling", from: 8, to: 21, title: "Weeks two and three" },
  { id: "widening", from: 22, to: 39, title: "Weeks four to six" },
  { id: "fortieth", from: 40, to: 40, title: "Day forty" },
];

export type FortyDaysNote = {
  id: string;
  stage: FortyDaysStageId;
  /** To her. */
  title: string;
  you: string;
  /** To whoever else opens her page: how to help with it. */
  othersTitle: (v: Voice) => string;
  others: (v: Voice) => string;
  /** A button under the note: "visitors" shares the visitor note. */
  action?: "visitors";
  sources: readonly FortyDaysSource[];
  /** "book": the book's tradition, in our words; "source": a health body's guidance; "both": the tradition checked against one. */
  basis: "book" | "source" | "both";
  /** YYYY-MM-DD the words were last checked against the sources. */
  reviewed: string;
  /** True until a person signs off on this note. */
  needsReview: boolean;
};

const note = (n: Omit<FortyDaysNote, "reviewed" | "needsReview"> & Partial<Pick<FortyDaysNote, "reviewed" | "needsReview">>): FortyDaysNote => ({
  reviewed: "2026-11-07",
  needsReview: true,
  ...n,
});

export const FORTY_DAY_NOTES: readonly FortyDaysNote[] = [
  // ── The first week ──
  note({
    id: "forty-days",
    stage: "week-one",
    title: "Forty days, for you",
    you: "In many cultures the weeks after a birth belong to the new mother, who rests and is fed while others run the house. Heng Ou's The First Forty Days carries that care, from the Chinese tradition of sitting the month, into today. One note a day, until day forty.",
    othersTitle: (v) => `Forty days for ${v.mom}`,
    others: (v) => `In many cultures the weeks after a birth belong to the new mother: she rests and is fed while the people around her cook, clean and keep things calm. One note a day until day forty, each with a way to help ${v.mom}.`,
    sources: [FORTY_DAYS_BOOK],
    basis: "book",
  }),
  note({
    id: "warmth",
    stage: "week-one",
    title: "Warmth, as comfort",
    you: "Warmth runs through the book, from the Chinese idea of keeping out wind and cold. Socks, a soft layer, warm food and a warm shower all count. Take it as comfort, not a rule: cold water and ice packs are fine when they're what helps, and the baby needs only one more layer than you.",
    othersTitle: (v) => `Keep ${v.mom} warm`,
    others: () => "Bring her socks and a soft layer, and something warm to drink when she isn't holding the baby. Comfort is the point: if she'd rather have cold water, bring that. The baby needs only one more layer than you, no more.",
    sources: [FORTY_DAYS_BOOK, WHO_POSTNATAL, AAP_SAFE_SLEEP],
    basis: "both",
  }),
  note({
    id: "rest",
    stage: "week-one",
    title: "Rest is the work",
    you: "The book asks for real rest: lie down, put the phone away, let others run the house. Rest isn't lying still all day, though. Getting up for short walks around the house helps you heal and lowers the risk of blood clots in these weeks.",
    othersTitle: (v) => `Protect ${v.mom}'s rest`,
    others: () => "Take a job off her list before she asks: the dishes, the laundry, the dog, the door. When she can lie down, take the baby so she can. Short walks around the house help her heal, so lend an arm if she'd like one.",
    sources: [FORTY_DAYS_BOOK, ACOG_CLOTS],
    basis: "both",
  }),
  note({
    id: "nest",
    stage: "week-one",
    title: "A quiet nest",
    you: "Keep your world small for a while: home, the baby, a few people. Make one spot your nest and keep it stocked: water, a snack you can eat with one hand, burp cloths, a charger, a pillow for feeding.",
    othersTitle: (v) => `Stock ${v.mom}'s spot`,
    others: () => "Keep her world small and easy for now. Before she sits down to feed, check her spot: water, a snack she can eat with one hand, burp cloths and a charger.",
    sources: [FORTY_DAYS_BOOK],
    basis: "book",
  }),
  note({
    id: "warm-food",
    stage: "week-one",
    title: "Soft, warm and simple",
    you: "To the book, food made by someone else is the most supportive help there is. Its kitchen runs on soups, stews, congee and broths, soft in the first week and heartier as your appetite grows. Have them between feeds, or while someone else holds the baby.",
    othersTitle: (v) => `Something warm for ${v.mom}`,
    others: () => "Bring her a warm bowl between feeds: soup, congee, or rice and eggs. During a feed, a drink and a snack she can eat with one hand are easier, and hot bowls and mugs stay out of the baby's reach.",
    sources: [FORTY_DAYS_BOOK, CAPT_SCALDS],
    basis: "both",
  }),
  note({
    id: "village",
    stage: "week-one",
    title: "Say yes to help",
    you: "The book talks about a village: the friends and family who carry the house so a new mother can rest. When someone offers, say yes and give them a job: a meal, a load of laundry, an hour with the baby while you sleep. Asking gets easier with practice.",
    othersTitle: () => "Don't wait to be asked",
    others: (v) => `Pick a job and do it. When friends ask what ${v.mom} needs, give them one too: a meal, an errand, the laundry.`,
    sources: [FORTY_DAYS_BOOK],
    basis: "book",
  }),
  note({
    id: "tender",
    stage: "week-one",
    title: "Tender days",
    you: "Tears that come easily in the first two weeks are very common, and company helps: the forty-day traditions keep a new mother close to her people. If low feelings last past two weeks, feel severe, or make it hard to get through the day, call your OB.",
    othersTitle: (v) => `Keep ${v.mom} company`,
    others: () => "Easy tears in the first two weeks are common. Sit with her, listen, and let her rest. If her low mood lasts past two weeks or seems severe, help her call her OB.",
    sources: [ACOG_PPD, FORTY_DAYS_BOOK],
    basis: "both",
  }),

  // ── Weeks two and three ──
  note({
    id: "little-often",
    stage: "settling",
    title: "Little and often",
    you: "Nursing can make you hungrier than you expect. Eat often, drink plenty, and keep a drink beside you when you settle in to feed. There's no special diet to follow: warm, simple food is a comfort, not a rule.",
    othersTitle: () => "A drink every feed",
    others: (v) => `Every time ${v.mom} sits down to feed, bring her a drink and a snack she can eat with one hand, without being asked.`,
    sources: [NHS_DIET, FORTY_DAYS_BOOK],
    basis: "both",
  }),
  note({
    id: "check-in",
    stage: "settling",
    title: "Your own check-in",
    you: "ACOG recommends talking with your OB within the first three weeks after birth, and a full postpartum visit by twelve weeks. It's about you: your body, your mood, your sleep and how feeding is going.",
    othersTitle: (v) => `${v.mom}'s own check-in`,
    others: (v) => `ACOG recommends ${v.mom} talk with her OB within three weeks of the birth. Help her book it, and offer to come along or take the baby.`,
    sources: [ACOG_736],
    basis: "source",
  }),
  note({
    id: "visitors",
    stage: "settling",
    title: "Visitors who help",
    you: "The book wants visitors who help, not visitors you host. Keep visits short, and ask everyone to wash their hands, to come another day if they're unwell, and to be up to date on whooping cough and flu shots two weeks ahead. A warm meal beats a gift.",
    othersTitle: (v) => `Answer the door for ${v.mom}`,
    others: (v) => `Be the one who answers the door and the texts for ${v.mom}. Keep visits short, ask everyone to wash their hands, ask anyone unwell to come another day, and suggest a meal instead of a gift.`,
    action: "visitors",
    sources: [FORTY_DAYS_BOOK, AAP_COCOON, CDC_CAREGIVER_VACCINES],
    basis: "both",
  }),
  note({
    id: "meals",
    stage: "settling",
    title: "Say food",
    you: "When someone asks what you need, say food: a soup, a stew or a rice dish that reheats well. A shared sign-up keeps meals spread across the weeks instead of all in the first one.",
    othersTitle: () => "Start a meal sign-up",
    others: (v) => `Set up a meal sign-up for ${v.mom} with friends and family, and ask for food that reheats well: soups, stews, rice dishes. Spread the days out so it lasts well past the first week.`,
    sources: [FORTY_DAYS_BOOK],
    basis: "book",
  }),
  note({
    id: "freezer",
    stage: "settling",
    title: "Soup in the freezer",
    you: "The book suggests filling the freezer before the birth, and it isn't too late: soups, stews and congee freeze well in single portions. Cool them in shallow containers, get them into the fridge within two hours, and reheat until steaming hot.",
    othersTitle: () => "Fill the freezer",
    others: () => "Cook a big pot and freeze it in single portions, labelled and dated. Cool it in shallow containers and get it into the fridge within two hours, so a warm bowl is always ready for her while someone else holds the baby.",
    sources: [FORTY_DAYS_BOOK, CDC_FOOD_SAFETY],
    basis: "both",
  }),
  note({
    id: "shower",
    stage: "settling",
    title: "A warm shower counts",
    you: "Some traditions skip bathing and hair washing for the whole month. You don't have to: showers are safe after birth, even after a cesarean, when letting the water run over the wound is usually all the cleaning it needs. Ask your OB before a soaking bath or a hot tub.",
    othersTitle: () => "Time for a shower",
    others: (v) => `Take the baby so ${v.mom} can have a warm shower in peace. Showers are safe after birth, even after a cesarean; a soaking bath waits for her OB's OK.`,
    sources: [MEDLINEPLUS_CSECTION],
    basis: "source",
  }),
  note({
    id: "wanted-help",
    stage: "settling",
    title: "The help you want",
    you: "Support helps most when it's the help you want. Studies of the Chinese month of rest found its customs alone don't reliably protect a mother's mood, while support a mother wants helps and conflict at home can hurt. Keep the parts that feel good, leave the rest, and ask for less advice and more laundry.",
    othersTitle: (v) => `The help ${v.mom} wants`,
    others: (v) => `Ask ${v.mom} what kind of help she wants, and from whom. Then protect it: steer the advice away and send helpers to the dishes.`,
    sources: [ACOG_PPD, CONFINEMENT_REVIEW],
    basis: "source",
  }),
  note({
    id: "air",
    stage: "settling",
    title: "A little air",
    you: "Many traditions keep a new mother indoors for the whole month. Rest still matters, and so does moving: a few minutes outside or a short walk, whenever you feel ready, is good for body and mood. After a cesarean, go at your OB's pace.",
    othersTitle: () => "Fresh air together",
    others: (v) => `When ${v.mom} feels ready, offer a short walk together, or a few minutes on the step while you hold the baby. She sets the pace.`,
    sources: [ACOG_EXERCISE, WHO_POSTNATAL, FORTY_DAYS_BOOK],
    basis: "both",
  }),

  // ── Weeks four to six ──
  note({
    id: "movement",
    stage: "widening",
    title: "Gentle movement",
    you: "If you're feeling ready, walking a little farther each day is a good start, and it may help your mood and your sleep. Stop if something hurts. After a cesarean or a complicated birth, ask your OB when to add more than walking.",
    othersTitle: (v) => `Walk at ${v.mom}'s pace`,
    others: () => "Make walks easy: you take the stroller and the bag, she sets the pace. If anything hurts she stops, and after a cesarean her OB says when to do more.",
    sources: [ACOG_EXERCISE],
    basis: "source",
  }),
  note({
    id: "ritual",
    stage: "widening",
    title: "Small rituals",
    you: "The forty-day traditions are full of small rituals, and yours can be tiny: a warm drink in the same chair each morning while someone else holds the baby, fresh clothes after a shower, a few quiet minutes that are only yours.",
    othersTitle: (v) => `A small ritual for ${v.mom}`,
    others: () => "Help her keep one small daily ritual: a warm drink in her favorite chair while you hold the baby, or a few quiet minutes to herself.",
    sources: [FORTY_DAYS_BOOK, CAPT_SCALDS],
    basis: "both",
  }),
  note({
    id: "still-warm",
    stage: "widening",
    title: "Keep the soup coming",
    you: "The warm, simple food can keep going as long as it helps. Soups and stews are an easy way to fit in vegetables, beans and whole grains too, which, with plenty of water, help prevent constipation.",
    othersTitle: () => "Keep the soup coming",
    others: (v) => `Keep the warm food coming for ${v.mom} past the first weeks: a pot of soup or stew with vegetables and beans on the weekend can carry the week.`,
    sources: [FORTY_DAYS_BOOK, WHO_POSTNATAL],
    basis: "both",
  }),
  note({
    id: "mother-too",
    stage: "widening",
    title: "A new mother, too",
    you: "The book sees the weeks after birth as the third act of having a baby, after pregnancy and birth, and a threshold into being a mother. It's a big change, and it's fine to miss parts of your old life while you find a new rhythm.",
    othersTitle: (v) => `Ask about ${v.mom}`,
    others: (v) => `${v.mom} is in the middle of a big change, and new mothers are easy to forget once the baby arrives. Ask about her, not just the baby, and listen.`,
    sources: [FORTY_DAYS_BOOK],
    basis: "book",
  }),
  note({
    id: "beyond",
    stage: "widening",
    title: "Beyond the first forty days",
    you: "Think about the help you'd like to keep once the forty days end: a meal a week, someone for one night feed, a standing walk with a friend. ACOG suggests a postpartum plan for just this. Ask now, while people are asking how to help.",
    othersTitle: () => "Help that lasts",
    others: (v) => `Plan with ${v.mom} for after the forty days: who brings food, who takes a night feed, who checks in. Healing keeps going after day forty.`,
    sources: [ACOG_736, FORTY_DAYS_BOOK],
    basis: "both",
  }),
  note({
    id: "check-mood",
    stage: "widening",
    title: "Keep checking in",
    you: "Low feelings can start any time in the first year, not just the first weeks. If you feel sad, empty or anxious most days for two weeks, call your OB. It's common, it isn't your fault, and it's treatable.",
    othersTitle: () => "Keep checking in",
    others: (v) => `Postpartum depression can begin any time in the first year. If ${v.mom} seems low most days for two weeks, tell her kindly what you've noticed and offer to call her OB together.`,
    sources: [ACOG_PPD],
    basis: "source",
  }),

  // ── Day forty ──
  note({
    id: "fortieth",
    stage: "fortieth",
    title: "Day forty",
    you: "Many traditions mark this day with a meal, a blessing or a first outing. It's a marker, not a finish line, and none of it was about bouncing back. Healing goes on, so keep the help that's helping, and your full postpartum visit, any time up to twelve weeks after the birth, if it's still ahead.",
    othersTitle: (v) => `Mark day forty with ${v.mom}`,
    others: (v) => `Many traditions mark the fortieth day with a meal, a blessing or a first outing. Mark it with ${v.mom} however she'd like, and keep the help coming: healing doesn't end today.`,
    sources: [FORTY_DAYS_BOOK, ACOG_736],
    basis: "both",
  }),
];

/** What these notes are (the card's sheet), in our words. The last paragraph alone names herbs and medicines, to say who to ask. */
export const FORTY_DAYS_ABOUT: readonly string[] = [
  "In many cultures the weeks after a birth belong to the new mother: in Chinese tradition, zuo yuezi, sitting the month; across Latin America, la cuarentena, the forty days. How long it lasts and what it involves varies from place to place and family to family.",
  "These notes borrow from The First Forty Days: The Essential Art of Nourishing the New Mother, by Heng Ou with Amely Greeven and Marisa Belger (2016). Heng Ou learned sitting the month from her aunt, and her book carries it into forty days, about the six weeks doctors call the postpartum period, built on rest, warmth, warm food made by others, a circle of help and a quiet home. The words here are ours.",
  "They're comforts, not rules: keep what feels good and leave the rest. Where a note touches your health, it follows ACOG, the WHO, the CDC, the AAP or the NHS and links to them. Nothing here suggests herbs, supplements, tonics or medicines. Some traditional dishes are cooked with rice wine, which simmering doesn't fully cook off, and some herbs can affect bleeding, so before trying a traditional remedy, ask your OB, the baby's pediatrician or a pharmacist.",
];

/** Support's forty days card: how to let people help (hers) and how to help (everyone else's). The book is credited beside it. */
export const fortyDaysHelp = (v: Voice) => ({
  heading: "The first forty days",
  intro: "In many cultures, the weeks after a birth are for the new mother to rest and be fed while the people around her carry the house.",
  you: [
    "Say yes when people offer help, and give them a job: a meal, the laundry, an hour with the baby while you sleep.",
    "Keep visits few and short. It's fine to say not yet.",
    "Let others cook: soups, stews and congee between feeds, and a snack you can eat with one hand during them.",
    "Ask for the help you want, and less of the help you don't.",
  ],
  others: [
    `Each time ${v.mom} sits down to feed, bring her a drink and a snack she can eat with one hand.`,
    "Save hot drinks and bowls for when someone else is holding the baby. A hot drink can scald a baby even 15 minutes after it's made.",
    "Take the jobs before she asks: dishes, laundry, meals, the door, the group chat.",
    "Agree on a simple signal she can give when she needs a hand, a break or the room cleared.",
    "Keep visits short. Ask visitors to wash their hands, to come another day if they're unwell, and to bring a meal if they'd like to help.",
    `Mark day forty with ${v.mom}, however she'd like.`,
  ],
  sources: [AAP_COCOON, CAPT_SCALDS] as readonly FortyDaysSource[],
});

/**
 * A note the family can send to anyone planning a visit (Share, or Copy where
 * there's no share sheet). It names no one: whoever sends it adds their own
 * words. AAP's cocooning page and the CDC: hands, staying away when sick,
 * whooping cough and flu shots at least two weeks before meeting the baby, and
 * no kisses for the baby.
 */
export const visitorNote = (v: Voice): string => {
  void v;
  return "We're taking these first weeks slowly, and we'd love to see you. Please text before you come, keep visits short, wash your hands when you arrive, and save the baby kisses for later. If you're feeling unwell, come another day. If you can, be up to date on your whooping cough and flu shots at least two weeks before. And if you'd like to help, a meal we can heat up is the best gift.";
};

/** Notes waiting for a person's sign-off, newest check first. */
export const fortyDaysPendingReview = (): readonly FortyDaysNote[] =>
  FORTY_DAY_NOTES.filter((n) => n.needsReview).sort((a, b) => b.reviewed.localeCompare(a.reviewed));
