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

const CDC = (months: number): DevelopmentSource => ({
  label: `CDC: by ${months === 24 ? "2 years" : `${months} months`}`,
  url: `https://www.cdc.gov/act-early/milestones/${months === 12 ? "1-year" : months === 24 ? "2-years" : `${months}-months`}.html`,
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

export const DISCOVERIES: readonly Discovery[] = [
  {
    id: "face-in-focus", topic: "brain", minMonths: 0, maxMonths: 2, ageBasis: "developmental",
    title: "Your face is in focus",
    body: "Newborns see best about 8 to 12 inches away, roughly the distance to your face during a feed. Close-up moments give them something familiar to look at.",
    activity: "Hold them comfortably and talk softly face-to-face.",
    source: { label: "American Academy of Pediatrics", url: "https://www.healthychildren.org/English/ages-stages/baby/Pages/Babys-Vision-Development.aspx" },
  },
  {
    id: "watching-hands", topic: "brain", minMonths: 2, maxMonths: 6, ageBasis: "developmental",
    title: "Hands worth watching",
    body: "By 4 months, most babies look at their hands with interest. The things closest to them can become fascinating discoveries.",
    activity: "Notice what catches their attention during a quiet moment together.",
    source: CDC(4),
  },
  {
    id: "mouth-exploring", topic: "brain", minMonths: 4, maxMonths: 9, ageBasis: "developmental",
    title: "Exploring, mouth first",
    body: "By 6 months, most babies bring things to their mouth to explore. Mouthing is one way they learn about objects, so keep small objects and choking hazards out of reach.",
    activity: "Offer a clean, age-appropriate toy while you supervise.",
    source: CDC(6),
  },
  {
    id: "ordinary-brain-building", topic: "brain", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "Learning in little moments",
    body: "Back-and-forth moments with a caring adult help strengthen developing brain connections. Looking, listening, and responding can turn ordinary time together into an opportunity to learn.",
    activity: "Follow what interests them and name what they are looking at.",
    source: RESPONSIVE,
  },
  {
    id: "small-conversations", topic: "connection", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "They start the conversation",
    body: "A look, a sound, or a movement can be an invitation. Responding with your voice, expression, or touch supports the connections involved in communication and social skills.",
    activity: "Notice a cue, respond, then pause for their turn.",
    source: RESPONSIVE,
  },
  {
    id: "comfort-and-connection", topic: "connection", minMonths: 0, maxMonths: 3, ageBasis: "developmental",
    title: "Comfort is connection",
    body: "By 2 months, most babies calm when someone talks to them or picks them up. Your voice and touch can help them settle, though every moment is different.",
    activity: "Try soft talking, holding, or singing when they need comfort.",
    source: CDC(2),
  },
  {
    id: "peekaboo-together", topic: "connection", minMonths: 6, maxMonths: 13, ageBasis: "developmental",
    title: "A familiar face, a little surprise",
    body: "By 9 months, most babies smile or laugh during peek-a-boo. A familiar face disappearing and returning can become a game you enjoy together.",
    activity: "Cover your own eyes with your hands, then uncover them and say peek-a-boo.",
    source: CDC(9),
  },
  {
    id: "naming-feelings", topic: "connection", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Putting feelings into words",
    body: "Naming feelings helps your child begin learning about emotions. Simple words such as sad, happy, or frustrated connect what they notice with language.",
    activity: "If someone looks upset, name the feeling and show a kind response.",
    source: CDC(18),
  },
  {
    id: "tiny-growing-tummy", topic: "feeding", minMonths: 0, maxMonths: 1, ageBasis: "chronological",
    title: "A tiny tummy, growing fast",
    body: "A newborn's stomach is small and grows as they grow. Feeding needs vary, so a fixed stomach-size picture cannot tell you how much your baby needs.",
    activity: "Notice their hunger and fullness cues, and follow their individual feeding plan.",
    source: { label: "CDC: early feeding", url: "https://www.cdc.gov/infant-toddler-nutrition/formula-feeding/how-much-and-how-often.html" },
  },
  {
    id: "early-hunger-cues", topic: "feeding", minMonths: 0, maxMonths: 6, ageBasis: "chronological",
    title: "Hungry before the cry",
    body: "Hands moving toward the mouth, turning toward a breast or bottle, and lip-smacking can signal hunger. Crying often comes later. Closing the mouth or turning away can signal fullness.",
    activity: "Which cues have you noticed during feeds?",
    source: FEEDING_CUES,
  },
  {
    id: "new-flavors", topic: "feeding", minMonths: 6, maxMonths: 9, ageBasis: "chronological",
    title: "Getting ready for new flavors",
    body: "Around 6 months, babies may be ready for foods alongside milk feeds. Readiness includes steady head control, sitting with support, and swallowing food instead of pushing it back out. Age and readiness both matter.",
    activity: "Talk with your care team about readiness, especially if your baby was born early.",
    source: { label: "CDC: introducing foods", url: "https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html" },
  },
  {
    id: "following-fullness", topic: "feeding", minMonths: 6, maxMonths: 25, ageBasis: "chronological",
    title: "Fullness has its own signals",
    body: "Pushing food away, closing their mouth, or turning away can mean your child has had enough. They do not need to finish everything offered. Follow your care team's advice if they have an individual feeding plan.",
    activity: "Pause and notice what their movements are telling you.",
    source: FEEDING_CUES,
  },
  {
    id: "cartilage-kneecaps", topic: "movement", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "Yes, they have kneecaps",
    body: "Baby kneecaps start as cartilage. Bone develops within them later in childhood. Those tiny knees already have their own structure, even before the kneecaps have hardened into bone.",
    source: { label: "Genetics of the patella, clinical review", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6461774/" },
  },
  {
    id: "little-tummy-time", topic: "movement", minMonths: 0, maxMonths: 6, ageBasis: "developmental", action: "tummy",
    title: "A little tummy time",
    body: "Awake, closely supervised tummy time helps your baby build strength. Start with short sessions and gradually add time as they become comfortable. Your face or a nearby toy can make floor time more interesting.",
    activity: "Try a brief session after a diaper change. Always place them on their back for sleep.",
    source: TUMMY_TIME,
  },
  {
    id: "reaching-for-play", topic: "movement", minMonths: 4, maxMonths: 9, ageBasis: "developmental",
    title: "Something worth reaching for",
    body: "By 6 months, most babies reach to grab a toy they want. Safe play on the floor gives them room to explore what their hands and body can do.",
    activity: "Place a safe toy nearby while you sit and play together.",
    source: CDC(6),
  },
  {
    id: "ball-back-and-forth", topic: "movement", minMonths: 18, maxMonths: 25, ageBasis: "developmental",
    title: "A ball and a little space",
    body: "A ball offers lots of ways to move and play together. Your child can explore rolling, throwing, or kicking as their skills develop.",
    activity: "Roll a soft, age-appropriate ball back and forth in a clear space while you supervise.",
    source: CDC(24),
  },
  {
    id: "words-in-the-day", topic: "communication", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "Words in an ordinary day",
    body: "Naming what your child sees, does, or feels helps connect experiences with language, even before they can talk. Everyday care gives you plenty to talk about.",
    activity: "Describe one thing you are doing together, then pause to listen.",
    source: RESPONSIVE,
  },
  {
    id: "books-before-words", topic: "communication", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "Books before words",
    body: "Your child does not need to understand a story to enjoy sharing it. Hearing your voice introduces the rhythms and sounds of language, while the closeness gives you a chance to connect.",
    activity: "Share a page or two and follow their interest.",
    source: BOOKS,
  },
  {
    id: "your-turn-my-turn", topic: "communication", minMonths: 2, maxMonths: 7, ageBasis: "developmental",
    title: "Your turn, my turn",
    body: "By 4 months, most babies make sounds back when you talk to them. A little coo can be their contribution to the conversation.",
    activity: "Copy a sound, then leave a little space for their reply.",
    source: CDC(4),
  },
  {
    id: "building-on-words", topic: "communication", minMonths: 12, maxMonths: 25, ageBasis: "developmental",
    title: "Adding a little more",
    body: "When your child tries a word, you can respond with a slightly fuller phrase. If they say more, you might say more banana. They get to hear the words in a familiar moment.",
    activity: "Follow their meaning and repeat it in a short phrase.",
    source: CDC(24),
  },
  {
    id: "sleep-rhythms-growing", topic: "sleep", minMonths: 0, maxMonths: 4, ageBasis: "chronological",
    title: "Sleep rhythms are still growing",
    body: "Newborn sleep comes in short stretches, and regular sleep cycles take time to develop. An uneven pattern in the early months is not a parenting score.",
    source: { label: "American Academy of Pediatrics", url: "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/Getting-Your-Baby-to-Sleep.aspx" },
  },
  {
    id: "back-for-sleep", topic: "sleep", minMonths: 0, maxMonths: 12, ageBasis: "chronological",
    title: "Different positions for different moments",
    body: "Tummy time is for awake, closely supervised play. When it is time to sleep, place your baby on their back. These two routines support different needs.",
    source: TUMMY_TIME,
  },
  {
    id: "familiar-wind-down", topic: "sleep", minMonths: 0, maxMonths: 25, ageBasis: "chronological",
    title: "A familiar way to wind down",
    body: "A predictable series of quiet steps can help your child wind down. The routine can be simple: a familiar book, a song, and a calm goodnight.",
    activity: "Choose a short sequence that feels comfortable for your family.",
    source: BEDTIME,
  },
  {
    id: "bedtime-book", topic: "sleep", minMonths: 0, maxMonths: 25, ageBasis: "chronological",
    title: "A story-shaped pause",
    body: "Sharing a book can become a comforting part of bedtime. It gives you a quiet moment together and a familiar step your child can begin to recognize.",
    activity: "Look at a few pages together before settling for sleep.",
    source: BOOKS,
  },
  {
    id: "time-to-respond", topic: "brain", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "A pause leaves room to think",
    body: "Children need time to form a response. A pause gives them room to join in with a glance, a sound, or a movement.",
    activity: "After responding to them, wait and watch for their next turn.",
    source: RESPONSIVE_STEPS,
  },
  {
    id: "follow-their-curiosity", topic: "brain", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "Curiosity gives you a clue",
    body: "What holds their attention tells you something about their interests. Sharing that focus encourages them to explore and helps you learn about what they need.",
    activity: "Look at what they are noticing and join their interest.",
    source: RESPONSIVE_STEPS,
  },
  {
    id: "ready-for-a-pause", topic: "connection", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "They can say all done without words",
    body: "Looking elsewhere, letting go of a toy, or becoming fussy can mean they are ready to move on. Noticing those signals helps you follow their lead.",
    activity: "Let a shared activity end when their interest changes.",
    source: RESPONSIVE_STEPS,
  },
  {
    id: "connection-during-care", topic: "connection", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "Connection fits into everyday care",
    body: "Getting dressed or waiting together can hold a small moment of connection. You do not need a separate activity to notice and respond to your child.",
    activity: "During the next change of clothes, notice a look or sound and respond.",
    source: RESPONSIVE_STEPS,
  },
  {
    id: "individual-feeding-needs", topic: "feeding", minMonths: 0, maxMonths: 6, ageBasis: "chronological",
    title: "Their appetite is their own",
    body: "Babies of the same age can have different feeding needs. A schedule or another baby's bottle cannot tell you exactly what yours needs. Your pediatrician can help with questions about their feeding and growth.",
    source: { label: "American Academy of Pediatrics: feeding needs", url: "https://www.healthychildren.org/English/ages-stages/baby/formula-feeding/Pages/Amount-and-Schedule-of-Formula-Feedings.aspx" },
  },
  {
    id: "no-empty-bottle-goal", topic: "feeding", minMonths: 0, maxMonths: 6, ageBasis: "chronological",
    title: "The bottle does not set the finish line",
    body: "When you offer a bottle, your baby does not have to finish it. Their fullness cues help you notice when they have had enough. Follow their care team's advice if they have an individual feeding plan.",
    source: FEEDING_CUES,
  },
  {
    id: "attention-at-mealtimes", topic: "feeding", minMonths: 6, maxMonths: 25, ageBasis: "chronological",
    title: "A meal is time together",
    body: "Your attention is part of mealtime. Facing each other, talking, and reducing distractions can help make meals a shared experience as your child learns to eat.",
    activity: "Sit together and keep watching while they eat.",
    source: MEALTIMES,
  },
  {
    id: "learning-with-a-spoon", topic: "feeding", minMonths: 6, maxMonths: 25, ageBasis: "chronological",
    title: "A little mess, a new skill",
    body: "Learning to eat includes practicing with fingers, spoons, and cups as skills develop. Spills and mess can be part of that learning.",
    activity: "Offer an unbreakable, age-appropriate utensil while they sit safely and you supervise.",
    source: MEALTIMES,
  },
  {
    id: "room-for-movement", topic: "movement", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "A little room to move",
    body: "Time for active play supports growing movement skills. A safe space and your company give your child opportunities to explore movements they can already make.",
    activity: "Join them for supervised play on a clear floor or play mat.",
    source: { label: "World Health Organization: active play", url: "https://www.who.int/news-room/detail/24-04-2019-to-grow-up-healthy-children-need-to-sit-less-and-play-more" },
  },
  {
    id: "a-different-view", topic: "movement", minMonths: 0, maxMonths: 6, ageBasis: "developmental",
    title: "A different view of the room",
    body: "Changing your baby's position during awake play lets them see the world from different angles. Support their head and body, and stay with them while they explore.",
    activity: "Try awake floor play on their back. Tummy play needs close supervision; sleep stays on their back.",
    source: PLAY,
  },
  {
    id: "actions-have-effects", topic: "movement", minMonths: 7, maxMonths: 25, ageBasis: "developmental",
    title: "I did that!",
    body: "Moving a toy and watching what happens helps your child discover that their actions have effects. Simple play offers chances to explore cause and effect.",
    activity: "Put a safe toy within reach and watch what they choose to do with it.",
    source: PLAY,
  },
  {
    id: "familiar-song", topic: "communication", minMonths: 0, maxMonths: 25, ageBasis: "developmental",
    title: "A familiar song has a lot to say",
    body: "Singing offers patterns of sound and words for your child to hear. Music can also be a way to share a feeling and enjoy time together.",
    activity: "Sing a song you like, in any language your family uses.",
    source: { label: "Head Start: music with infants and toddlers", url: "https://headstart.gov/publication/using-music-infants-toddlers-their-families" },
  },
  {
    id: "brief-night-wakings", topic: "sleep", minMonths: 12, maxMonths: 25, ageBasis: "chronological",
    title: "Sleep includes brief awakenings",
    body: "Even toddlers wake briefly during the night. Some settle again on their own; others call for you. A consistent, calming bedtime routine can help support their sleep habits.",
    source: { label: "Nationwide Children's Hospital: toddler sleep", url: "https://www.nationwidechildrens.org/specialties/sleep-disorder-center/sleep-in-toddlers" },
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
