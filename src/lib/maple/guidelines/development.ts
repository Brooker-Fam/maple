export const DEVELOPMENT_TOPICS = [
  { id: "brain", label: "Brain & senses" },
  { id: "connection", label: "Connection & feelings" },
  { id: "feeding", label: "Feeding & nutrition" },
  { id: "movement", label: "Movement & play" },
  { id: "communication", label: "Language & listening" },
  { id: "sleep", label: "Sleep & rhythms" },
] as const;

export type DevelopmentTopic = (typeof DEVELOPMENT_TOPICS)[number]["id"];
export type DevelopmentSource = { label: string; url: string };
export type Discovery = {
  id: string;
  topic: DevelopmentTopic;
  title: string;
  body: string;
  activity?: string;
  action?: "tummy";
  minMonths: number;
  maxMonths: number;
  ageBasis: "developmental" | "chronological";
  source: DevelopmentSource;
};
export type DevelopmentMilestone = {
  id: string;
  label: string;
  byMonths: number;
  source: DevelopmentSource;
};

/**
 * The months where each stage starts: the newborn weeks, then 2, 4, 6, 9, 12
 * and 18 months (CDC's milestone checkpoints), up to the second birthday.
 * Every discovery is written for its stage: its window stays inside one stage,
 * or two that meet, and its words fit every age in it, so nothing written for a
 * toddler reaches a newborn (pnpm check:maple-development).
 */
export const DEVELOPMENT_STAGE_STARTS = [0, 2, 4, 6, 9, 12, 18] as const;

const CDC = (months: number): DevelopmentSource => ({
  label: `CDC: by ${months === 24 ? "2 years" : `${months} months`}`,
  url: `https://www.cdc.gov/act-early/milestones/${months === 12 ? "1-year" : months === 24 ? "2-years" : `${months}-months`}.html`,
});
const AAP = (label: string, path: string): DevelopmentSource => ({
  label: `American Academy of Pediatrics: ${label}`,
  url: `https://www.healthychildren.org/English/${path}`,
});
const RESPONSIVE = {
  label: "Harvard Center on the Developing Child",
  url: "https://developingchild.harvard.edu/key-concept/serve-and-return/",
};
const BOOKS = {
  label: "American Academy of Pediatrics",
  url: "https://www.healthychildren.org/English/ages-stages/baby/Pages/how-to-share-books-with-your-baby.aspx",
};
const FEEDING_CUES = {
  label: "CDC: hunger and fullness cues",
  url: "https://www.cdc.gov/infant-toddler-nutrition/mealtime/signs-your-child-is-hungry-or-full.html",
};
const TUMMY_TIME = {
  label: "American Academy of Pediatrics",
  url: "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/Back-to-Sleep-Tummy-to-Play.aspx",
};
const BEDTIME = {
  label: "American Academy of Pediatrics",
  url: "https://www.healthychildren.org/English/healthy-living/oral-health/Pages/Brush-Book-Bed.aspx",
};
const RESPONSIVE_STEPS = {
  label: "Harvard: five steps for everyday connection",
  url: "https://developingchild.harvard.edu/resources/briefs/5-steps-for-brain-building-serve-and-return/",
};
const PLAY = {
  label: "American Academy of Pediatrics: the power of play",
  url: "https://www.healthychildren.org/English/family-life/power-of-play/Pages/The-Power-of-Play-How-Fun-and-Games-Help-Children-Thrive.aspx",
};
const MEALTIMES = {
  label: "CDC: mealtime routines",
  url: "https://www.cdc.gov/infant-toddler-nutrition/mealtime/index.html",
};
const VISION = AAP("how babies see", "ages-stages/baby/Pages/Babys-Vision-Development.aspx");
const HEARING = AAP("hearing and making sounds", "ages-stages/baby/Pages/Hearing-and-Making-Sounds.aspx");
const BEFORE_BIRTH = AAP("hearing before birth", "tips-tools/ask-the-pediatrician/Pages/I%E2%80%99m-pregnant-and-would-like-to-sing-to-my-unborn-baby.aspx");
const REFLEXES = AAP("newborn reflexes", "ages-stages/baby/Pages/Newborn-Reflexes.aspx");
const FIRST_SMILE = AAP("first smiles", "tips-tools/ask-the-pediatrician/Pages/When-do-babies-first-smile.aspx");
const FUSSING = AAP("fussy periods", "ages-stages/baby/crying-colic/Pages/Colic.aspx");
const BABY_SLEEP = AAP("baby sleep", "ages-stages/baby/sleep/Pages/Getting-Your-Baby-to-Sleep.aspx");
const SAFE_SLEEP = AAP("safe sleep", "ages-stages/baby/sleep/Pages/A-Parents-Guide-to-Safe-Sleep.aspx");
const MOVES_0_3 = AAP("movement, birth to 3 months", "ages-stages/baby/Pages/Movement-Birth-to-Three-Months.aspx");
const MOVES_4_7 = AAP("movement, 4 to 7 months", "ages-stages/baby/Pages/Movement-4-to-7-Months.aspx");
const MOVES_8_12 = AAP("movement, 8 to 12 months", "ages-stages/baby/Pages/Movement-8-to-12-Months.aspx");
const TEMPERAMENT = AAP("4 to 7 months", "ages-stages/baby/Pages/Emotional-and-Social-Development-4-7-Months.aspx");
const THINKING_8_12 = AAP("thinking, 8 to 12 months", "ages-stages/baby/Pages/Cognitive-Development-8-to-12-Months.aspx");
const TALKING_8_12 = AAP("language, 8 to 12 months", "ages-stages/baby/Pages/Language-Development-8-to-12-Months.aspx");
const LITERACY = AAP("early literacy", "ages-stages/baby/Pages/Developmental-Milestones-of-Early-Literacy.aspx");
const TODDLER_FEELINGS = AAP("feelings at 1 year", "ages-stages/toddler/Pages/Emotional-Development-1-Year-Olds.aspx");
const FEEDING_OFTEN = {
  label: "CDC: how often babies feed",
  url: "https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html",
};
const SOLIDS = {
  label: "CDC: introducing foods",
  url: "https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html",
};
const UTENSILS = {
  label: "CDC: fingers, spoons, forks, and cups",
  url: "https://www.cdc.gov/infant-toddler-nutrition/mealtime/fingers-spoons-forks-and-cups.html",
};
const NEW_FOODS = {
  label: "CDC: picky eaters",
  url: "https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/picky-eaters.html",
};
const ACTIVE_PLAY = {
  label: "World Health Organization: active play",
  url: "https://www.who.int/news-room/detail/24-04-2019-to-grow-up-healthy-children-need-to-sit-less-and-play-more",
};

export const DEVELOPMENT_COPY = {
  rotation: "A daily idea for this stage, not a change that happens on this exact day.",
  milestoneIntro: "A few things to notice as they grow.",
  milestoneNote: "CDC milestones describe skills most children can do by an age. This selection is not a complete checklist or a developmental screening.",
  milestoneConcern: "If your child has not reached a milestone by the listed age, has lost a skill, or you have a concern, talk with their pediatrician and ask about developmental screening.",
  correctedAge: "Developmental ideas use corrected age for babies born before 37 weeks, through age 2. Feeding and sleep guidance use time since birth. Follow your care team's individual advice.",
  correctedAgeSource: {
    label: "American Academy of Pediatrics: corrected age",
    url: "https://www.healthychildren.org/english/ages-stages/baby/preemie/pages/preemie-milestones.aspx",
  },
  tummySafety: "Tummy time is only for an awake baby with an adult closely supervising. Put babies on their backs for sleep.",
} as const;

// Grouped by the stage each discovery starts in. Within a stage the topics take
// turns, so a family that reads a mixture sees a different topic from day to day.
export const DISCOVERIES: readonly Discovery[] = [
  // ── The newborn weeks ──
  {
    id: "face-in-focus", topic: "brain", minMonths: 0, maxMonths: 2, ageBasis: "developmental",
    title: "Your face is in focus",
    body: "Newborns see best about 8 to 12 inches away, roughly the distance to your face during a feed. Close-up moments give them something familiar to look at.",
    activity: "Hold them comfortably and talk softly face-to-face.",
    source: VISION,
  },
  {
    id: "comfort-and-connection", topic: "connection", minMonths: 0, maxMonths: 3, ageBasis: "developmental",
    title: "Comfort is connection",
    body: "By 2 months, most babies calm when someone talks to them or picks them up. Your voice and touch can help them settle, though every moment is different.",
    activity: "Try soft talking, holding, or singing when they need comfort.",
    source: CDC(2),
  },
  {
    id: "tiny-growing-tummy", topic: "feeding", minMonths: 0, maxMonths: 1, ageBasis: "chronological",
    title: "A tiny tummy, growing fast",
    body: "A newborn's stomach is small and grows as they grow. Feeding needs vary, so a fixed stomach-size picture cannot tell you how much your baby needs.",
    activity: "Notice their hunger and fullness cues, and follow their individual feeding plan.",
    source: { label: "CDC: early feeding", url: "https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html" },
  },
  {
    id: "little-tummy-time", topic: "movement", minMonths: 0, maxMonths: 2, ageBasis: "developmental", action: "tummy",
    title: "A little tummy time",
    body: "Awake, closely supervised tummy time helps your baby build strength. Start with a few minutes, two or three times a day, and add time as they enjoy it. Your face or a nearby toy gives them something to lift their head for.",
    activity: "Try a brief session after a diaper change. Always place them on their back for sleep.",
    source: TUMMY_TIME,
  },
  {
    id: "books-before-words", topic: "communication", minMonths: 0, maxMonths: 4, ageBasis: "developmental",
    title: "Books before words",
    body: "It's never too early to share a book. Your baby won't follow the story, but they're taking in the rhythm and sounds of your voice, and the closeness is good for you both.",
    activity: "Read a few lines with them snuggled close. If they look away or fuss, it's fine to stop.",
    source: BOOKS,
  },
  {
    id: "sleep-rhythms-growing", topic: "sleep", minMonths: 0, maxMonths: 4, ageBasis: "chronological",
    title: "Sleep rhythms are still growing",
    body: "Regular sleep cycles usually take until about 4 months to develop, so newborns often sleep only 1 or 2 hours at a time. An uneven pattern in these early months is not a parenting score.",
    source: BABY_SLEEP,
  },
  {
    id: "voice-they-know", topic: "brain", minMonths: 0, maxMonths: 2, ageBasis: "developmental",
    title: "Your voice stands out",
    body: "Babies prefer human voices to other sounds and tune in to the ones they hear most. By about 1 month, they can usually recognize your voice, even from another room.",
    activity: "Say hello as you come into the room, and notice how they respond.",
    source: HEARING,
  },
  {
    id: "a-look-away", topic: "connection", minMonths: 0, maxMonths: 2, ageBasis: "developmental",
    title: "A look away can mean a break",
    body: "Turning their head away, yawning, or getting fussy can be your baby's way of saying they need a pause. Responding to those signals helps them feel safe, and you'll learn them as you go.",
    activity: "When they turn away, soften your voice and give them a moment.",
    source: CDC(2),
  },
  {
    id: "early-hunger-cues", topic: "feeding", minMonths: 0, maxMonths: 4, ageBasis: "chronological",
    title: "Hungry before the cry",
    body: "Hands to the mouth, turning toward the breast or bottle, lip-smacking, and clenched hands can all signal hunger. Crying is often a late sign, so feeding at the early ones can keep things calmer.",
    activity: "Which early cues have you noticed?",
    source: FEEDING_CUES,
  },
  {
    id: "newborn-reflexes", topic: "movement", minMonths: 0, maxMonths: 2, ageBasis: "developmental",
    title: "Some moves happen on their own",
    body: "Many newborn movements are reflexes they don't control yet. Stroke their palm and their fingers grip yours; a sudden noise brings a startle, arms flung out, then pulled in. Some reflexes fade within weeks, others over a few months.",
    activity: "Gently stroke their palm and feel them grip your finger.",
    source: REFLEXES,
  },
  {
    id: "familiar-song", topic: "communication", minMonths: 0, maxMonths: 4, ageBasis: "developmental",
    title: "Songs they may already know",
    body: "Babies can hear voices from outside the womb late in pregnancy, so familiar voices and songs can be comforting after birth. Singing is one more way to share your voice.",
    activity: "Sing a song you like, in any language your family uses.",
    source: BEFORE_BIRTH,
  },
  {
    id: "days-and-nights", topic: "sleep", minMonths: 0, maxMonths: 4, ageBasis: "chronological",
    title: "Lively days, quiet nights",
    body: "Keeping night feeds and changes calm and quiet, and saving play for the daytime, can help your baby sleep for longer stretches at night over time.",
    activity: "At night, keep the lights low and your voice soft.",
    source: BABY_SLEEP,
  },
  {
    id: "ordinary-brain-building", topic: "brain", minMonths: 0, maxMonths: 4, ageBasis: "developmental",
    title: "Learning in little moments",
    body: "When your baby cries, looks at you, or makes a sound and you respond, that back-and-forth helps build connections in their developing brain. Everyday care is full of these moments.",
    activity: "Answer a look or a sound with your voice, a smile, or a cuddle.",
    source: RESPONSIVE,
  },
  {
    id: "fussy-evenings", topic: "connection", minMonths: 0, maxMonths: 4, ageBasis: "developmental",
    title: "Fussy evenings are common",
    body: "Many babies have a fussy stretch most days, often in the evening. It usually peaks around 6 weeks and eases by 3 to 4 months. If you need a break, it's OK to lay them on their back in a safe place and step away for a few minutes.",
    activity: "Try slow rocking, a soft steady sound, or a walk in your arms.",
    source: FUSSING,
  },
  {
    id: "little-and-often", topic: "feeding", minMonths: 0, maxMonths: 2, ageBasis: "chronological",
    title: "Little and often",
    body: "Newborns usually feed 8 to 12 times in 24 hours, and some feeds come close together. Long feeds and short ones are both normal; babies tend to stop when they're full.",
    source: FEEDING_OFTEN,
  },
  {
    id: "a-different-view", topic: "movement", minMonths: 0, maxMonths: 4, ageBasis: "developmental",
    title: "A different view of the room",
    body: "Changing your baby's position during awake play lets them see the world from different angles. Support their head and body, and stay with them while they explore.",
    activity: "Try awake floor play on their back. Tummy play needs close supervision; sleep stays on their back.",
    source: PLAY,
  },
  {
    id: "sing-song-voice", topic: "communication", minMonths: 0, maxMonths: 4, ageBasis: "developmental",
    title: "That sing-song voice works",
    body: "Babies prefer human voices, especially higher-pitched ones. The slower, sing-song way many adults talk to babies, with big expressions, is just right for catching their attention.",
    activity: "During a quiet, alert moment, talk to them face-to-face and watch them watch you.",
    source: HEARING,
  },
  {
    id: "back-for-sleep", topic: "sleep", minMonths: 0, maxMonths: 4, ageBasis: "chronological",
    title: "Different positions for different moments",
    body: "Tummy time is for awake, closely supervised play. When it is time to sleep, place your baby on their back. These two routines support different needs.",
    source: TUMMY_TIME,
  },
  {
    id: "eyes-working-together", topic: "brain", minMonths: 0, maxMonths: 2, ageBasis: "developmental",
    title: "Two eyes learning to work together",
    body: "It takes practice for babies to use both eyes together, so a newborn's eyes may sometimes wander or cross. This usually settles by 2 to 3 months, and your pediatrician checks their eyes at each visit.",
    source: VISION,
  },
  {
    id: "connection-during-care", topic: "connection", minMonths: 0, maxMonths: 4, ageBasis: "developmental",
    title: "Connection fits into everyday care",
    body: "Feeds, diaper changes, and baths are natural moments to connect. Talking and smiling while you care for your baby gives them your face and voice up close.",
    activity: "During the next diaper change, tell them what you're doing.",
    source: CDC(2),
  },
  {
    id: "individual-feeding-needs", topic: "feeding", minMonths: 0, maxMonths: 4, ageBasis: "chronological",
    title: "Their appetite is their own",
    body: "Babies of the same age can have different feeding needs. A schedule or another baby's bottle cannot tell you exactly what yours needs. Your pediatrician can help with questions about their feeding and growth.",
    source: { label: "American Academy of Pediatrics: feeding needs", url: "https://www.healthychildren.org/English/ages-stages/baby/formula-feeding/Pages/Amount-and-Schedule-of-Formula-Feedings.aspx" },
  },
  {
    id: "room-not-bed", topic: "sleep", minMonths: 0, maxMonths: 4, ageBasis: "chronological",
    title: "Close by, in a bed of their own",
    body: "The AAP recommends sharing a room with your baby, but not a bed, for at least the first 6 months. Their own firm, flat sleep space near your bed also makes night feeds easier.",
    source: SAFE_SLEEP,
  },
  {
    id: "first-smiles", topic: "connection", minMonths: 1, maxMonths: 4, ageBasis: "developmental",
    title: "The first real smiles",
    body: "A baby's first social smile usually appears by the end of the second month. When you smile back, they learn their smile gets a response, and the smile conversations begin.",
    activity: "Smile and talk softly, then pause to see if a smile comes back.",
    source: FIRST_SMILE,
  },

  // ── 2 to 4 months ──
  {
    id: "eyes-that-follow", topic: "brain", minMonths: 2, maxMonths: 4, ageBasis: "developmental",
    title: "Eyes that follow",
    body: "By 3 months, babies can usually focus on faces and nearby objects and follow something moving with their eyes.",
    activity: "Move a brightly colored toy slowly from side to side and watch their eyes follow it.",
    source: VISION,
  },
  {
    id: "smiles-that-invite", topic: "connection", minMonths: 2, maxMonths: 6, ageBasis: "developmental",
    title: "Smiles that invite you in",
    body: "By 4 months, most babies smile on their own to get your attention and may chuckle when you play. A look, a wiggle, or a coo can be their way of starting a moment together.",
    activity: "When they smile at you, smile back and tell them what you see.",
    source: CDC(4),
  },
  {
    id: "they-know-whats-coming", topic: "feeding", minMonths: 2, maxMonths: 6, ageBasis: "chronological",
    title: "They know what's coming",
    body: "By 4 months, most hungry babies open their mouth when they see the breast or bottle. It's one of the ways they start telling you what they need.",
    activity: "Notice how they show they're done, like closing their mouth or turning away.",
    source: CDC(4),
  },
  {
    id: "reasons-to-reach", topic: "movement", minMonths: 2, maxMonths: 6, ageBasis: "developmental", action: "tummy",
    title: "Lift, turn, and reach",
    body: "Tummy time builds the strength your baby will use to roll, scoot, and crawl. Toys placed around them, or your face just out of reach, give them reasons to lift, turn, and reach.",
    activity: "Lie on the floor face-to-face, or set a few toys in a circle around them.",
    source: TUMMY_TIME,
  },
  {
    id: "your-turn-my-turn", topic: "communication", minMonths: 2, maxMonths: 6, ageBasis: "developmental",
    title: "Your turn, my turn",
    body: "By 4 months, most babies make sounds back when you talk to them. A little coo can be their contribution to the conversation.",
    activity: "Copy a sound, then leave a little space for their reply.",
    source: CDC(4),
  },
  {
    id: "swaddling-and-rolling", topic: "sleep", minMonths: 2, maxMonths: 6, ageBasis: "chronological",
    title: "When rolling starts, swaddling stops",
    body: "If you swaddle, stop as soon as your baby shows signs of trying to roll over. Rolling often starts around 3 to 4 months, sometimes earlier, and rolling onto their tummy while swaddled raises the risk of suffocation.",
    source: SAFE_SLEEP,
  },
  {
    id: "finding-your-voice", topic: "brain", minMonths: 2, maxMonths: 4, ageBasis: "developmental",
    title: "Where's that voice?",
    body: "By 4 months, most babies turn their head toward the sound of your voice. You may notice them searching for you when you speak from across the room.",
    activity: "Talk to them from one side, then the other, and see if they turn to find you.",
    source: CDC(4),
  },
  {
    id: "no-empty-bottle-goal", topic: "feeding", minMonths: 2, maxMonths: 6, ageBasis: "chronological",
    title: "The bottle does not set the finish line",
    body: "When you offer a bottle, your baby does not have to finish it. Their fullness cues help you notice when they have had enough. Follow their care team's advice if they have an individual feeding plan.",
    source: FEEDING_CUES,
  },
  {
    id: "room-for-movement", topic: "movement", minMonths: 2, maxMonths: 6, ageBasis: "developmental",
    title: "A little room to move",
    body: "Floor play gives your baby room to kick, reach, and wiggle. The WHO suggests babies spend no more than an hour at a time strapped into a stroller or seat.",
    activity: "Join them for supervised play on a clear floor or play mat.",
    source: ACTIVE_PLAY,
  },
  {
    id: "routines-to-expect", topic: "sleep", minMonths: 2, maxMonths: 6, ageBasis: "chronological",
    title: "Routines help them know what's next",
    body: "Steady routines for sleeping and feeding help babies begin to learn what to expect. A routine can be short, like a diaper change, a song, and a cuddle.",
    activity: "Pick two or three calm steps and repeat them before sleep.",
    source: CDC(2),
  },
  {
    id: "watching-hands", topic: "brain", minMonths: 2, maxMonths: 6, ageBasis: "developmental",
    title: "Hands worth watching",
    body: "By 4 months, most babies look at their hands with interest. The things closest to them can become fascinating discoveries.",
    activity: "Notice what catches their attention during a quiet moment together.",
    source: CDC(4),
  },
  {
    id: "ready-to-roll", topic: "movement", minMonths: 2, maxMonths: 6, ageBasis: "developmental",
    title: "Ready to roll",
    body: "Around 3 months, stronger kicks can tip some babies from tummy to back, and more rolling follows. Since it can happen without warning, never leave your baby alone on a bed or other furniture.",
    source: MOVES_0_3,
  },

  // ── 4 to 6 months ──
  {
    id: "colors-and-shapes", topic: "brain", minMonths: 4, maxMonths: 6, ageBasis: "developmental",
    title: "Colors coming into view",
    body: "Around 4 months, babies see colors and shades better and often reach for things close by. Round shapes and patterns can be especially interesting, which may be one reason they love faces.",
    activity: "Hold a brightly colored, baby-safe toy where they can reach it.",
    source: VISION,
  },
  {
    id: "their-own-style", topic: "connection", minMonths: 4, maxMonths: 8, ageBasis: "developmental",
    title: "A personality showing through",
    body: "Between about 4 and 7 months, your baby's temperament gets easier to see: how active they are, how they handle change, and how quickly they warm up. Every baby's style is their own.",
    activity: "Notice what helps them settle and what gets them excited.",
    source: TEMPERAMENT,
  },
  {
    id: "new-flavors", topic: "feeding", minMonths: 4, maxMonths: 8, ageBasis: "chronological",
    title: "Getting ready for new flavors",
    body: "Around 6 months, babies may be ready for foods alongside milk feeds. Readiness includes steady head control, sitting with support, and swallowing food instead of pushing it back out. Age and readiness both matter.",
    activity: "Talk with your care team about readiness, especially if your baby was born early.",
    source: SOLIDS,
  },
  {
    id: "reaching-for-play", topic: "movement", minMonths: 4, maxMonths: 9, ageBasis: "developmental",
    title: "Something worth reaching for",
    body: "By 6 months, most babies reach to grab a toy they want. Safe play on the floor gives them room to explore what their hands and body can do.",
    activity: "Place a safe toy nearby while you sit and play together.",
    source: CDC(6),
  },
  {
    id: "raspberries-and-squeals", topic: "communication", minMonths: 4, maxMonths: 8, ageBasis: "developmental",
    title: "Raspberries and squeals",
    body: "By 6 months, most babies take turns making sounds with you, blow raspberries, and squeal. Copying their sounds keeps the back-and-forth going.",
    activity: "Blow a raspberry back and see what they do.",
    source: CDC(6),
  },
  {
    id: "rolling-and-sleep", topic: "sleep", minMonths: 4, maxMonths: 9, ageBasis: "chronological",
    title: "On their back, even once they roll",
    body: "Keep placing your baby on their back for every sleep. Once they can roll both ways on their own, you don't need to turn them back over, as long as their sleep space has no blankets, pillows, or toys.",
    source: SAFE_SLEEP,
  },
  {
    id: "mouth-exploring", topic: "brain", minMonths: 4, maxMonths: 9, ageBasis: "developmental",
    title: "Exploring, mouth first",
    body: "By 6 months, most babies bring things to their mouth to explore. Mouthing is one way they learn about objects, so keep small objects and choking hazards out of reach.",
    activity: "Offer a clean, age-appropriate toy while you supervise.",
    source: CDC(6),
  },
  {
    id: "face-in-the-mirror", topic: "connection", minMonths: 4, maxMonths: 9, ageBasis: "developmental",
    title: "A face in the mirror",
    body: "By 6 months, most babies like to look at themselves in a mirror. A baby-safe mirror gives them a fascinating face to study.",
    activity: "Look into a baby-safe mirror together and make a few faces.",
    source: CDC(6),
  },
  {
    id: "finding-their-feet", topic: "movement", minMonths: 4, maxMonths: 8, ageBasis: "developmental",
    title: "Toes are fascinating",
    body: "As their coordination improves, babies discover new parts of their bodies. Lying on their back, many can now grab their feet and bring their toes to their mouth.",
    activity: "During a diaper change, let them reach for their feet and name what they find.",
    source: MOVES_4_7,
  },
  {
    id: "books-to-touch", topic: "communication", minMonths: 4, maxMonths: 9, ageBasis: "developmental",
    title: "Books are for touching, too",
    body: "Around 6 months, babies hold books, pat the pictures, and often taste them. Mouthing a book is a normal way to explore, which is why sturdy board and cloth books work well now.",
    activity: "Name and point to the pictures that catch their eye.",
    source: BOOKS,
  },
  {
    id: "sitting-up", topic: "movement", minMonths: 5, maxMonths: 9, ageBasis: "developmental",
    title: "Sitting up for a new view",
    body: "Many babies first sit by leaning forward on their hands for balance. By 6 to 8 months, many can stay sitting once you set them upright, which opens up a whole new view.",
    activity: "Sit close behind them as they practice, with a few toys in front to look at.",
    source: MOVES_4_7,
  },

  // ── 6 to 9 months ──
  {
    id: "actions-have-effects", topic: "brain", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "I did that!",
    body: "Dropping a toy and watching it fall is an early experiment. When you hand it back and they drop it again, they're learning that their actions have effects.",
    activity: "Make it a game: pick up the dropped toy and give it back.",
    source: PLAY,
  },
  {
    id: "peekaboo-together", topic: "connection", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "A familiar face, a little surprise",
    body: "By 9 months, most babies smile or laugh during peek-a-boo. A familiar face disappearing and returning can become a game you enjoy together.",
    activity: "Cover your own eyes with your hands, then uncover them and say peek-a-boo.",
    source: CDC(9),
  },
  {
    id: "smooth-to-lumpy", topic: "feeding", minMonths: 6, maxMonths: 9, ageBasis: "chronological",
    title: "From smooth to lumpy",
    body: "Smooth mashed or pureed foods are easiest at first. Thicker, lumpier textures can come as your baby's eating skills develop, and some coughing or gagging can happen while they adjust.",
    activity: "Stay with them and watch while they eat.",
    source: SOLIDS,
  },
  {
    id: "ways-to-get-there", topic: "movement", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "Every way of getting there",
    body: "Crawling usually appears between 7 and 10 months, but some babies scoot on their bottoms or slide on their tummies instead, and a few skip crawling. What matters is that they're exploring and using both sides of their body.",
    activity: "Place a toy a little out of reach and cheer them on as they go for it.",
    source: MOVES_8_12,
  },
  {
    id: "babble-to-words", topic: "communication", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "Mamamama, bababa",
    body: "By 9 months, most babies babble strings of sounds like “mamamama” and “bababa.” Repeating their sounds and adding a real word links their babble to language.",
    activity: "If they say “bababa,” say it back, then try “ball” or “book.”",
    source: CDC(9),
  },
  {
    id: "bedtime-book", topic: "sleep", minMonths: 6, maxMonths: 12, ageBasis: "chronological",
    title: "A story-shaped pause",
    body: "Sharing a book can become a comforting part of bedtime. When the same quiet steps happen each night, your baby begins to know what comes next.",
    activity: "Look at a few pages together before settling for sleep.",
    source: BOOKS,
  },
  {
    id: "follow-their-curiosity", topic: "brain", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "Curiosity gives you a clue",
    body: "What holds your baby's attention tells you something about their interests. Looking at it together and talking about it encourages them to keep exploring.",
    activity: "When they look at something, point to it and name it.",
    source: RESPONSIVE_STEPS,
  },
  {
    id: "shy-with-new-faces", topic: "connection", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "Shy with new faces",
    body: "By 9 months, most babies are shy or clingy around strangers and react when you leave. It shows how much their familiar people matter.",
    activity: "Say a quick, cheerful goodbye instead of slipping away, and greet them warmly when you're back.",
    source: CDC(9),
  },
  {
    id: "following-fullness", topic: "feeding", minMonths: 6, maxMonths: 12, ageBasis: "chronological",
    title: "Fullness has its own signals",
    body: "Pushing food away, closing their mouth, or turning their head can mean your baby has had enough. They do not need to finish everything offered. Follow your care team's advice if they have an individual feeding plan.",
    activity: "Pause and notice what their movements are telling you.",
    source: FEEDING_CUES,
  },
  {
    id: "cartilage-kneecaps", topic: "movement", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "Yes, they have kneecaps",
    body: "As your baby gets moving, those knees do a lot of work. Baby kneecaps start as cartilage, and bone develops within them later in childhood.",
    source: { label: "Genetics of the patella, clinical review", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6461774/" },
  },
  {
    id: "waking-and-resettling", topic: "sleep", minMonths: 6, maxMonths: 12, ageBasis: "chronological",
    title: "Waking and settling again",
    body: "It's normal for babies around 6 months to wake during the night and drift back to sleep after a few minutes. You can still feed, change, or comfort them when they need it.",
    source: BABY_SLEEP,
  },
  {
    id: "ready-for-a-pause", topic: "connection", minMonths: 6, maxMonths: 12, ageBasis: "developmental",
    title: "They can say all done without words",
    body: "Looking away, dropping a toy, or getting fussy can mean your baby is ready to move on. Noticing those signals helps you follow their lead.",
    activity: "Let a shared activity end when their interest changes.",
    source: RESPONSIVE_STEPS,
  },
  {
    id: "many-tries", topic: "feeding", minMonths: 6, maxMonths: 12, ageBasis: "chronological",
    title: "New foods can take many tries",
    body: "Your baby might not like a food the first time. It can take 8 to 10 tries before a young child accepts a new food, so it's worth offering it again another day.",
    activity: "Offer it again in about a week, maybe mixed with a food they already like.",
    source: NEW_FOODS,
  },
  {
    id: "naps-count", topic: "sleep", minMonths: 6, maxMonths: 12, ageBasis: "chronological",
    title: "Naps count, too",
    body: "Babies 4 to 12 months old need 12 to 16 hours of sleep a day, including naps. Consistent sleep times can make it easier.",
    source: CDC(9),
  },
  {
    id: "out-of-sight", topic: "brain", minMonths: 8, maxMonths: 12, ageBasis: "developmental",
    title: "Out of sight, still there",
    body: "Around 8 months, babies start to understand that things still exist when they can't see them, an idea called object permanence.",
    activity: "While they watch, hide a toy under a blanket and see if they look for it.",
    source: THINKING_8_12,
  },
  {
    id: "fingers-first", topic: "feeding", minMonths: 8, maxMonths: 12, ageBasis: "chronological",
    title: "Little fingers, little bites",
    body: "Picking up food with their fingers helps babies build fine motor skills, and by 12 months most can feed themselves finger foods easily.",
    activity: "Offer a few soft, small pieces and let them try while you watch.",
    source: UTENSILS,
  },
  {
    id: "words-in-the-day", topic: "communication", minMonths: 8, maxMonths: 12, ageBasis: "developmental",
    title: "Words in an ordinary day",
    body: "Your baby understands more than they can say. Talking simply about what's happening, like “I'm drying you with the big blue towel,” connects everyday moments with words.",
    activity: "Describe one thing you are doing together, then pause to listen.",
    source: TALKING_8_12,
  },

  // ── 9 to 12 months ──
  {
    id: "little-scientist", topic: "brain", minMonths: 9, maxMonths: 12, ageBasis: "developmental",
    title: "A little scientist at work",
    body: "Banging, shaking, and rolling things are how babies find out how objects behave. Some things roll, some don't, and some fit inside others.",
    activity: "Offer safe household things, like a wooden spoon and a plastic container, and see what they try.",
    source: THINKING_8_12,
  },
  {
    id: "open-cup", topic: "feeding", minMonths: 9, maxMonths: 12, ageBasis: "chronological",
    title: "Sips from an open cup",
    body: "Around 9 months, babies can start learning to drink from a cup without a lid, and by 12 months many can do it while you hold the cup. Spills are part of learning.",
    activity: "Hold a small open cup with a little water and let them sip.",
    source: UTENSILS,
  },
  {
    id: "up-on-their-feet", topic: "movement", minMonths: 9, maxMonths: 12, ageBasis: "developmental",
    title: "Up on their feet",
    body: "Many babies start pulling themselves up to stand and then walking along furniture while holding on. At first they may not know how to get back down.",
    activity: "If they get stuck standing, gently show them how to bend their knees to sit.",
    source: MOVES_8_12,
  },
  {
    id: "pointing-at-pictures", topic: "communication", minMonths: 9, maxMonths: 12, ageBasis: "developmental",
    title: "Pointing at pictures",
    body: "Books with everyday things, like balls and blocks, are great now. Naming what they point to and asking “Where's the bird?” brings the idea of conversation into reading.",
    activity: "Follow their lead. There's no need to finish the story.",
    source: BOOKS,
  },
  {
    id: "talking-with-hands", topic: "communication", minMonths: 9, maxMonths: 12, ageBasis: "developmental",
    title: "Talking with their hands",
    body: "Toward the end of the first year, babies show what they want by pointing and gesturing, and they copy the gestures they see you make.",
    activity: "Wave and say “bye-bye” when someone leaves.",
    source: TALKING_8_12,
  },
  {
    id: "what-counts-as-a-word", topic: "communication", minMonths: 9, maxMonths: 18, ageBasis: "developmental",
    title: "What counts as a word",
    body: "Early words don't have to be perfect. Any sound your child uses the same way each time, like “ba” for ball, counts as a word. Answering with the whole word helps them hear how it sounds.",
    activity: "If they say “ba” for ball, try “Ball! Yes, that's a ball.”",
    source: TALKING_8_12,
  },

  // ── 12 to 18 months ──
  {
    id: "time-to-respond", topic: "brain", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "A pause leaves room to think",
    body: "Toddlers need time to form a response. Waiting a few seconds after you ask or say something gives them room to join in with a word, a gesture, or a sound.",
    activity: "Ask a simple question, then wait a few seconds before you help.",
    source: RESPONSIVE_STEPS,
  },
  {
    id: "naming-feelings", topic: "connection", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Putting feelings into words",
    body: "Naming feelings helps your child begin learning about emotions. Simple words such as sad, happy, or frustrated connect what they notice with language.",
    activity: "If someone looks upset, name the feeling and show a kind response.",
    source: CDC(18),
  },
  {
    id: "appetites-vary", topic: "feeding", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "Appetites go up and down",
    body: "Toddlers often eat more one day and less the next, and that's normal. You choose what to offer; they can decide how much to eat.",
    source: MEALTIMES,
  },
  {
    id: "first-steps", topic: "movement", minMonths: 12, maxMonths: 18, ageBasis: "developmental",
    title: "First steps, wide and wobbly",
    body: "Many children take first steps around their first birthday, though earlier or later is normal too. New walkers keep their feet wide for balance, and bumps and tumbles are part of learning.",
    activity: "Let them hold your hands or push a sturdy box across the floor. Baby walkers aren't recommended.",
    source: MOVES_8_12,
  },
  {
    id: "building-on-words", topic: "communication", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Adding a little more",
    body: "When your child tries a word, you can respond with a slightly fuller phrase. If they say more, you might say more banana. They get to hear the words in a familiar moment.",
    activity: "Follow their meaning and repeat it in a short phrase.",
    source: CDC(24),
  },
  {
    id: "familiar-wind-down", topic: "sleep", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "A familiar way to wind down",
    body: "A predictable bedtime routine helps your child know what comes next. The AAP suggests a simple one: brush their teeth, share a book, and go to bed at a regular time.",
    activity: "Choose a short sequence that feels comfortable for your family.",
    source: BEDTIME,
  },
  {
    id: "what-things-are-for", topic: "brain", minMonths: 12, maxMonths: 18, ageBasis: "developmental",
    title: "Learning what things are for",
    body: "By 15 months, most children try to use everyday things the way you do, like a phone, a cup, or a book. Watching and copying you is how they learn.",
    activity: "Put a hat on your head, then hand it over and see if they copy you.",
    source: CDC(15),
  },
  {
    id: "exploring-and-checking-back", topic: "connection", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Off exploring, checking back",
    body: "In the second year, many children swing between bold independence and wanting you close, especially when they're tired or unsure. Heading off, then checking back with you, is part of feeling secure.",
    activity: "When they come back for reassurance, offer it. They'll head off again when they're ready.",
    source: TODDLER_FEELINGS,
  },
  {
    id: "picky-phases", topic: "feeding", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "Picky phases are normal",
    body: "As children get older, they may refuse foods they used to like or not want foods to touch on the plate. These habits are normal and often fade by about age 5.",
    activity: "Eat the food yourself first, so they can see you enjoy it.",
    source: NEW_FOODS,
  },
  {
    id: "plenty-of-play", topic: "movement", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Plenty of time to move",
    body: "The WHO suggests at least 3 hours of active play spread through the day for 1- and 2-year-olds, at any pace, and no more than an hour at a time strapped into a stroller or seat.",
    activity: "Walking, climbing, dancing, and chasing all count. Join in when you can.",
    source: ACTIVE_PLAY,
  },
  {
    id: "a-point-is-a-question", topic: "communication", minMonths: 12, maxMonths: 18, ageBasis: "developmental",
    title: "A point is a question",
    body: "By 15 months, most children point to ask for something or to get help. Naming what they point at gives them the word they're reaching for.",
    activity: "Name it, then wait a few seconds to see if they try to say it before you hand it over.",
    source: CDC(15),
  },
  {
    id: "brief-night-wakings", topic: "sleep", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "Sleep includes brief awakenings",
    body: "Even toddlers wake briefly during the night. Some settle again on their own; others call for you. A consistent, calming bedtime routine can help support their sleep habits.",
    source: { label: "Nationwide Children's Hospital: toddler sleep", url: "https://www.nationwidechildrens.org/specialties/sleep-disorder-center/sleep-in-toddlers" },
  },
  {
    id: "stack-and-topple", topic: "brain", minMonths: 12, maxMonths: 18, ageBasis: "developmental",
    title: "Stack it, topple it",
    body: "By 15 months, most children can stack two small objects, like blocks. Stacking, filling, and dumping help them learn how things fit together.",
    activity: "Build a small tower together and let them knock it down.",
    source: CDC(15),
  },
  {
    id: "look-what-i-found", topic: "connection", minMonths: 12, maxMonths: 18, ageBasis: "developmental",
    title: "Look what I found",
    body: "By 15 months, most children show you things they like and share affection with hugs, cuddles, or kisses. Bringing you a toy is an invitation to share their interest.",
    activity: "When they bring you something, name it and say what you notice about it.",
    source: CDC(15),
  },
  {
    id: "attention-at-mealtimes", topic: "feeding", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "A meal is time together",
    body: "Sitting down together helps your child learn how to eat and builds social skills. Facing each other, talking, and keeping screens away make meals a shared experience.",
    activity: "Sit together and keep watching while they eat.",
    source: MEALTIMES,
  },
  {
    id: "push-pull-go", topic: "movement", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Push, pull, and go",
    body: "Once they're walking steadily, many toddlers love toys they can push or pull, and the noisier the better.",
    activity: "Offer a sturdy toy they can push or pull safely, like a wagon with a handle.",
    source: MOVES_8_12,
  },
  {
    id: "bring-me-a-book", topic: "communication", minMonths: 12, maxMonths: 18, ageBasis: "developmental",
    title: "Bring me a book",
    body: "Between 12 and 18 months, many children carry books around, hand them to you to read, and point to pictures when you ask “Where is the…?” Turning several pages at once is part of it.",
    activity: "Ask “Where's the dog?” and give them time to point.",
    source: LITERACY,
  },
  {
    id: "toddler-sleep-needs", topic: "sleep", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "Sleep adds up across the day",
    body: "Children between 1 and 2 years old need 11 to 14 hours of sleep a day, including naps. Consistent sleep times can make it easier.",
    source: CDC(15),
  },
  {
    id: "learning-with-a-spoon", topic: "feeding", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "A little mess, a new skill",
    body: "After about 12 months, children get better quickly at using spoons, forks, and cups. Spills and mess are part of learning.",
    activity: "Offer an unbreakable, age-appropriate utensil while they sit safely and you supervise.",
    source: UTENSILS,
  },
  {
    id: "songs-with-actions", topic: "communication", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Songs with actions",
    body: "Songs with gestures, like “The Wheels on the Bus,” invite your child to join in with their hands and body.",
    activity: "Sing a song with motions and see if they try some of the actions.",
    source: CDC(15),
  },
  {
    id: "two-naps-to-one", topic: "sleep", minMonths: 12, maxMonths: 18, ageBasis: "chronological",
    title: "Two naps become one",
    body: "By about 18 months, most toddlers have dropped their morning nap and take one longer afternoon nap. Each child's timing is a little different.",
    source: { label: "Nationwide Children's Hospital: toddler sleep", url: "https://www.nationwidechildrens.org/specialties/sleep-disorder-center/sleep-in-toddlers" },
  },
  {
    id: "big-feelings", topic: "connection", minMonths: 15, maxMonths: 25, ageBasis: "developmental",
    title: "Big feelings, small bodies",
    body: "Tantrums are normal at this age and more likely when a child is tired or hungry. They usually get shorter and happen less often as children grow.",
    activity: "Stay nearby and give them time to calm down, then move on together.",
    source: CDC(15),
  },
  {
    id: "little-helper", topic: "connection", minMonths: 15, maxMonths: 25, ageBasis: "developmental",
    title: "A little helper",
    body: "Many toddlers love to help. Fetching their shoes or putting socks in the basket lets them practice new skills and join in everyday life.",
    activity: "Give them one small job during a chore you're already doing.",
    source: CDC(15),
  },

  // ── 18 months to 2 years ──
  {
    id: "lets-pretend", topic: "brain", minMonths: 18, maxMonths: 25, ageBasis: "developmental",
    title: "Let's pretend",
    body: "By 18 months, most children copy everyday chores, like sweeping, and many begin simple pretend play, like feeding a stuffed animal with a spoon.",
    activity: "Hand them a spoon and a stuffed animal, and take turns pretending.",
    source: CDC(18),
  },
  {
    id: "ball-back-and-forth", topic: "movement", minMonths: 18, maxMonths: 25, ageBasis: "developmental",
    title: "A ball and a little space",
    body: "A ball offers lots of ways to move and play together. Your child can explore rolling, throwing, or kicking as their skills develop.",
    activity: "Roll a soft, age-appropriate ball back and forth in a clear space while you supervise.",
    source: CDC(24),
  },
  {
    id: "finish-the-line", topic: "communication", minMonths: 18, maxMonths: 25, ageBasis: "developmental",
    title: "They'll finish the sentence",
    body: "Pause before the last word of a line in a favorite book, and your toddler may fill it in for you. Before long, they may tell familiar stories to their toys.",
    activity: "Read a favorite book and leave out a word they know.",
    source: LITERACY,
  },
  {
    id: "how-does-it-work", topic: "brain", minMonths: 18, maxMonths: 25, ageBasis: "developmental",
    title: "How does this work?",
    body: "By 2 years, most children try switches, knobs, and buttons on toys, and can hold something in one hand while using the other, like taking a lid off a container.",
    activity: "Offer a toy where pressing a button makes something happen.",
    source: CDC(24),
  },
  {
    id: "nose-and-toes", topic: "communication", minMonths: 18, maxMonths: 25, ageBasis: "developmental",
    title: "Nose, toes, and everything between",
    body: "By 2 years, most children can point to at least two body parts when you ask. Naming body parts at bath time or while dressing gives them lots of practice.",
    activity: "Sing “Head, Shoulders, Knees, and Toes” and touch each part as you go.",
    source: CDC(24),
  },
];

export const DEVELOPMENT_MILESTONES: readonly DevelopmentMilestone[] = [
  { id: "first-smile", label: "Smiles when you talk or smile", byMonths: 2, source: CDC(2) },
  { id: "looks-at-face", label: "Looks at your face", byMonths: 2, source: CDC(2) },
  { id: "holds-head-on-tummy", label: "Holds their head up on their tummy", byMonths: 2, source: CDC(2) },
  { id: "coos-back", label: "Makes sounds back when you talk", byMonths: 4, source: CDC(4) },
  { id: "holds-head-steady", label: "Holds their head steady while held", byMonths: 4, source: CDC(4) },
  { id: "hands-to-mouth", label: "Brings their hands to their mouth", byMonths: 4, source: CDC(4) },
  { id: "first-laugh", label: "Laughs", byMonths: 6, source: CDC(6) },
  { id: "rolls-tummy-to-back", label: "Rolls from tummy to back", byMonths: 6, source: CDC(6) },
  { id: "reaches-for-toy", label: "Reaches for a toy they want", byMonths: 6, source: CDC(6) },
  { id: "looks-when-name-called", label: "Looks when you call their name", byMonths: 9, source: CDC(9) },
  { id: "sits-without-support", label: "Sits without support", byMonths: 9, source: CDC(9) },
  { id: "looks-for-dropped-object", label: "Looks for something dropped out of sight", byMonths: 9, source: CDC(9) },
  { id: "waves-bye-bye", label: "Waves bye-bye", byMonths: 12, source: CDC(12) },
  { id: "pulls-up-to-stand", label: "Pulls up to stand", byMonths: 12, source: CDC(12) },
  { id: "puts-object-in-container", label: "Puts something in a container", byMonths: 12, source: CDC(12) },
  { id: "points-to-share-interest", label: "Points to show you something interesting", byMonths: 18, source: CDC(18) },
  { id: "walks-without-holding", label: "Walks without holding on", byMonths: 18, source: CDC(18) },
  { id: "tries-three-words", label: "Tries three words besides mama or dada", byMonths: 18, source: CDC(18) },
  { id: "two-words-together", label: "Says two words together", byMonths: 24, source: CDC(24) },
  { id: "kicks-ball", label: "Kicks a ball", byMonths: 24, source: CDC(24) },
  { id: "notices-others-upset", label: "Notices when someone is hurt or upset", byMonths: 24, source: CDC(24) },
];
