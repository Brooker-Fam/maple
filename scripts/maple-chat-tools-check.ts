/**
 * Assertions for progressive tool disclosure in the in-app chat
 * (src/lib/maple/chat/tool-groups.ts): the tool map (every chat tool in it,
 * once), what a message points to, groups kept from the model window, the
 * ceiling and what goes past it, and load_tools and a call to a tool its
 * step didn't send, end to end against a stand-in model.
 *
 *   npx tsx scripts/maple-chat-tools-check.ts   (part of pnpm check:maple-chat)
 *
 * Pure: no database and no network (stand-in tools run). Made-up people
 * only: owner Alex, member Sam, viewer Vi, baby June and Robin as the care
 * person. One PASS/FAIL line per case, exit 1 on any failure.
 */
import type { ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { CHAT_MAX_STEPS } from "../src/lib/maple/chat/caps";
import { userMessage } from "../src/lib/maple/chat/messages";
import { priceFor } from "../src/lib/maple/chat/prices";
import { systemBlocks } from "../src/lib/maple/chat/prompt";
import { chatTools, EXCLUDED_TOOLS, registrations } from "../src/lib/maple/chat/tools";
import {
  definitionSizes,
  definitionTokens,
  GROUP_ORDER,
  groupOf,
  LOAD_TOOLS,
  notLoadedNow,
  notLoadedOutput,
  PLANNED_TOOLS,
  predictGroups,
  readWindow,
  selectTools,
  TOOL_CEILING,
  TOOL_GROUPS,
  TOOL_ORDER,
  toolDisclosure,
  type ToolGroup,
} from "../src/lib/maple/chat/tool-groups";
import { chatTurn } from "../src/lib/maple/chat/turn";
import type { ChatMessage, ChatToolOutput } from "../src/lib/maple/chat/types";
import { webSearchTool } from "../src/lib/maple/chat/web-search";
import { toolCopy } from "../src/lib/maple/mcp-tools";
import type { Member } from "../src/lib/maple/types";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

const GLM = "zai/glm-5.3-flash";
const TZ = "America/New_York";
const COPY = toolCopy(2, { name: "June", nickname: null, sex: "female" }, "Robin", TZ);
const LINE = "Now: 3:10 AM EDT on Monday, Oct 26 (America/New_York). June is 6 days old (Day 7). Signed in: Alex (owner).";

type Who = Pick<Member, "email" | "role" | "care">;
const ALEX: Who = { email: "alex@example.com", role: "owner" };
const SAM: Who = { email: "sam@example.com", role: "member" };
const VI: Who = { email: "vi@example.com", role: "viewer" };

const SEARCH = { model: {} as never, modelKey: GLM, price: priceFor(GLM)!, names: { baby: ["June"], mom: ["Robin"], people: ["Alex"] } };

/** This person's chat tools as the route builds them (web search on unless `search: false`). */
function toolsFor(who: Who, opts: { care?: boolean; born?: boolean; self?: boolean; search?: boolean } = {}): ToolSet {
  return chatTools(who, { fam: 2, copy: COPY, born: opts.born ?? true, care: opts.care ?? true, ...(opts.self ? { self: true } : {}), device: null, ...(opts.search === false ? {} : { search: SEARCH }) });
}

/** The first step's selection for a new message, after `before` (older messages in the window). */
function route(who: Who, text: string, opts: { care?: boolean; born?: boolean; state?: string[]; before?: ChatMessage[] } = {}) {
  const tools = toolsFor(who, opts);
  const d = toolDisclosure(tools, { window: [...(opts.before ?? []), userMessage("msg_new", text, LINE, opts.state ?? [])], vo: COPY.v, lastStep: CHAT_MAX_STEPS - 1 });
  return { tools, d, sel: d.select(0, []) };
}

const groupNames = (g: ToolGroup | "core") => [...(TOOL_GROUPS[g] as readonly string[])];
const READ_ONLY = new Map(registrations(COPY).all.map((r) => [r.name, r.ann.readOnlyHint]));
/** The chat's own cards, which viewers have today (tools.ts). */
const CHAT_CARDS = new Set(["show_help", "ask_user", "show_chart", "search_entries", "open_screen", "get_settings", "propose_setting", "web_search", LOAD_TOOLS]);

/** A made-up earlier exchange whose reply called `name` (with `input`). */
function earlier(n: number, name: string, input: unknown = {}): ChatMessage[] {
  return [
    userMessage(`msg_u${n}`, `made-up question #${n}`, LINE),
    {
      id: `msg_a${n}`,
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: `tool-${name}`, toolCallId: `call_${n}`, state: "output-available", input, output: { ok: true, write: false, text: "made-up result" } },
        { type: "text", text: `made-up reply #${n}` },
      ] as ChatMessage["parts"],
    },
  ];
}

const DIAPERS = ["She had a wet diaper at 3:10", "Changed a poopy diaper, yellow and seedy, just now", "dirty diaper 10 minutes ago"];
const PLAIN = [...DIAPERS, "She nursed 15 minutes on the left and 10 on the right", "She took a 3 oz bottle of formula", "she's asleep", "she slept from 2 to 4:30", "she fed at 2, pooped, and slept until 4:30"];

// ── the map ──────────────────────────────────────────────────────────────

check("every chat tool has one place in the map, and every mapped tool is a chat tool (sleep_goal is planned)", () => {
  const seen = new Set<string>();
  for (const who of [ALEX, SAM, VI, { ...SAM, care: "view" as const }])
    for (const care of [true, false])
      for (const born of [true, false])
        for (const self of [true, false])
          for (const search of [true, false]) for (const name of Object.keys(toolsFor(who, { care, born, self, search }))) seen.add(name);
  seen.add(LOAD_TOOLS);
  for (const name of seen) ok(groupOf(name) !== null, `${name} is in TOOL_GROUPS`);
  eq(TOOL_ORDER.length, new Set(TOOL_ORDER).size, "no tool in two places");
  for (const name of TOOL_ORDER) ok(seen.has(name) || PLANNED_TOOLS.has(name), `${name} is mapped but no chat has it`);
  eq([...PLANNED_TOOLS], ["sleep_goal"], "planned");
  eq(groupOf("sleep_goal"), "sleep", "sleep_goal goes with the sleep plan");
  for (const name of EXCLUDED_TOOLS) eq(groupOf(name), null, `${name} never reaches the chat`);
  const approved = ["maple_status", "log_feed", "log_diaper", "log_sleep", "start_timer", "stop_timer", "switch_side", "pause_nursing", "fix_nursing_time", "reopen_timer", "log_many", "update_entry", "delete_entry", "restore_entry", "undo_last", "list_entries", "daily_summary", "ask_user", "show_help", "recall_memories", "save_memory"];
  // The approved core, plus load_tools and record_birth (there only before the birth).
  eq(groupNames("core").sort(), [...approved, LOAD_TOOLS, "record_birth"].sort(), "core");
  eq(GROUP_ORDER, ["mom", "health", "sleep", "log_more", "app", "people", "memory_admin"], "groups");
});

check("a tool missing from the map still goes, with core: it never silently vanishes", () => {
  const sizes = { ...definitionSizes(toolsFor(ALEX)), made_up_tool: 30 };
  const sel = selectTools({ sizes });
  ok(sel.active.includes("made_up_tool"), "an unmapped tool is sent");
  eq(sel.active.at(-1), "made_up_tool", "after the mapped ones");
});

check("each group's size, and any one of them loads beside core", () => {
  const sizes = definitionSizes(toolDisclosure(toolsFor(ALEX), { window: [], vo: COPY.v, lastStep: 5 }).tools);
  const of = (g: ToolGroup | "core") => definitionTokens(sizes, groupNames(g).filter((n) => n in sizes));
  const rows = (["core", ...GROUP_ORDER] as const).map((g) => `${g} ${of(g)}`);
  console.log(`  sizes (owner, her page open, web search on, tokens): ${rows.join(", ")}; all ${definitionTokens(sizes, Object.keys(sizes))}`);
  const unborn = definitionSizes(toolDisclosure(toolsFor(ALEX, { born: false }), { window: [], vo: COPY.v, lastStep: 5 }).tools);
  const coreUnborn = definitionTokens(unborn, groupNames("core").filter((n) => n in unborn));
  for (const g of GROUP_ORDER) ok(coreUnborn + of(g) <= TOOL_CEILING, `${g} fits beside core before the birth (${coreUnborn} + ${of(g)})`);
  ok(definitionTokens(sizes, Object.keys(sizes)) > TOOL_CEILING, "every tool at once is past the ceiling, which is why groups exist");
});

// ── what a message points to ─────────────────────────────────────────────

check("a diaper, a feed or a nap goes with core alone", () => {
  for (const text of PLAIN) {
    const { sel, tools } = route(ALEX, text);
    eq(sel.groups, [], text);
    eq(sel.active, groupNames("core").filter((n) => n in tools || n === LOAD_TOOLS), `${text}: exactly core`);
  }
});

check("the sleep plan's words, typed or seeded by Ask about this, send the sleep group", () => {
  for (const text of [
    "I put her down in the bassinet",
    "holding her now, my turn until 3",
    "What's our sleep goal?",
    "I go back to work in March, how do we get there?",
    "Can you hand her off to Sam at 4?",
    "How is the sleep plan going?",
    "Ask about this: stage 2 of the bassinet plan",
    "How do I get her to nap longer?",
  ]) ok(route(ALEX, text).sel.groups.includes("sleep"), text);
});

check("the [App] lines' running try, holding turn, plan, goals or last night's check-ins send sleep: a family that uses the plan always has its tools", () => {
  const tryLine = "Bassinet try t12 running: laid down at 2:10 AM (5 min ago) by Alex; try 1 tonight.";
  const holding = "Holding: Alex is holding June awake since 1:50 AM (h7); planned handoff 3:00 AM (in 50m) to Sam.";
  const plan = "Sleep plan: stage 1 (Held to sleep, then the bassinet); bassinet tries tonight: 0 of 2.";
  const goals = 'Sleep goals: g1 "Both of us get a protected stretch", 7 days left. sleep_plan has their progress and coach notes.';
  const checkins = "Check-ins for last night: Alex yes; not yet: Sam.";
  eq(route(ALEX, "she woke up", { state: [tryLine] }).sel.groups, ["sleep"], "a running try");
  eq(route(ALEX, "I'm getting sleepy", { state: [holding] }).sel.groups, ["sleep"], "holding");
  for (const line of [plan, goals, checkins]) eq(route(ALEX, "yes, mine held", { state: [line] }).sel.groups, ["sleep"], line);
  eq(route(ALEX, "she pooped", { state: ["Last feed: nursed at 7:10 AM today (2h 20m ago)."] }).sel.groups, [], "the log's own lines don't");
});

/**
 * How parents talk about sleep, from the coach review's routing captures:
 * these 38 load the sleep tools by their words alone; the 3 that don't
 * ("she slept 4 hours straight last night", "yes, mine held", "partly, she
 * was up at 2") load them through a plan's or goal's [App] lines, above.
 * The 9 control phrases, plain logging and people, never do.
 */
const SLEEP_TALK = [
  "back to work", "we both need sleep", "night shifts", "protected sleep", "how did last night go", "she only sleeps on me", "contact naps", "bassinet", "sleep plan", "night roster",
  "I go back to work in 4 weeks and we're both exhausted", "I'm back at work Monday", "my leave ends next month", "we're so tired", "can you make us a schedule so we each get some sleep",
  "how should we split the nights", "who's on tonight", "it's my turn to sleep", "Theo is taking the first shift tonight", "she won't sleep unless she's held", "she wakes up the second I put her down",
  "she only naps on me", "she slept 3 hours in the crib!", "rough night", "last night was rough", "she was up all night", "how are we doing on our goal", "are we on track", "my window held last night",
  "can my partner give her a bottle at night", "should I pump so he can do a night feed", "dream feed", "is it ok if she sleeps in the swing", "can she sleep in our bed", "can I let her cry for a few minutes",
  "I keep nodding off while feeding her",
  "Help us set a sleep goal: I go back to work in four weeks, we're breastfeeding, my partner's home, and we both need sleep",
  "Let's review our sleep goal: Both of us get a protected stretch before Noor is back at work",
];
const SLEEP_BY_STATE = ["she slept 4 hours straight last night", "yes, mine held", "partly, she was up at 2"];
const NOT_SLEEP = ["she pooped", "log a wet diaper", "she ate 3 oz", "start the left side", "how many diapers today", "she's on the left", "my mom is visiting", "who's in the family", "remove Theo's access"];

check("parents' own words about the nights load the sleep tools; plain logging and people never do", () => {
  eq(SLEEP_TALK.length, 38, "the review's 38");
  for (const said of SLEEP_TALK) ok(predictGroups({ said }).includes("sleep"), `loads sleep: "${said}"`);
  for (const said of NOT_SLEEP) ok(!predictGroups({ said }).includes("sleep"), `no sleep for a control phrase: "${said}"`);
  const goalLines = ['Sleep goals: g1 "Both of us get a protected stretch before Noor is back at work", 7 days left. sleep_plan has their progress and coach notes.', "Check-ins for last night: Noor yes; not yet: Theo."];
  for (const said of SLEEP_BY_STATE) {
    ok(!predictGroups({ said }).includes("sleep"), `by its words alone, not: "${said}"`);
    ok(predictGroups({ said, context: goalLines }).includes("sleep"), `with a goal's [App] lines: "${said}"`);
  }
  ok(!predictGroups({ said: "who's on tonight" }).includes("people") || predictGroups({ said: "who's on tonight" }).includes("sleep"), "who's on tonight is about the nights too");
});

/**
 * Coach round 2's 15 phrases from families with no plan or goal yet (so no
 * [App] lines to lean on): held naps on someone, waiting before going in,
 * sleep gear, whose turn it is, being worn out. Each loads the sleep tools by
 * its words alone; a feed's "swap sides" doesn't.
 */
const SLEEP_TALK_NO_PLAN = [
  "is it ok that she naps on my chest while I watch TV",
  "she fights the bassinet every time",
  "can we do turns tonight? I'm wrecked",
  "my husband goes back to work monday, how do we handle nights",
  "she screams the second her back touches the mattress",
  "how long should I wait before going in when she cries",
  "is the snoo worth it",
  "she sleeps better in the car seat, can she stay in it",
  "can I put her down on her tummy if I'm watching",
  "I fell asleep with her on the couch last night",
  "whose turn is it to get up",
  "I'm taking the 2am feed so he can sleep",
  "remind me to swap with Theo at 1:30",
  "did we hit our goal this week",
  "white noise all night ok",
];

check("before any plan or goal, a family's own words about held naps, waiting to go in, sleep gear and whose turn it is load the sleep tools; swapping sides in a feed doesn't", () => {
  eq(SLEEP_TALK_NO_PLAN.length, 15, "coach round 2's 15");
  for (const said of SLEEP_TALK_NO_PLAN) ok(predictGroups({ said }).includes("sleep"), `loads sleep: "${said}"`);
  for (const said of [...NOT_SLEEP, "swap sides", "swap to the right", "she's swapping breasts a lot", "swap breasts after 10 minutes", ...PLAIN]) ok(!predictGroups({ said }).includes("sleep"), `no sleep: "${said}"`);
});

check("her name or her medicine sends her page's tools, only when the chat may see it", () => {
  const hers = groupNames("mom");
  const stateLine = "Robin's next medicine: Examplex OK after 9:10 AM.";
  for (const [text, state] of [["Robin took ibuprofen at 2", []], ["Can I take my Tylenol yet?", []], ["Log that she took the Examplex", [stateLine]], ["Robin's temp is 100.2", []]] as const) {
    const open = route(ALEX, text, { state: [...state] }).sel;
    ok(hers.every((n) => open.active.includes(n)), `${text}: all of hers when open`);
    const closed = route(ALEX, text, { care: false, state: [...state] }).sel;
    eq(closed.active.filter((n) => hers.includes(n)), [], `${text}: none of hers when closed`);
    eq(route(VI, text, { state: [...state] }).sel.active.filter((n) => hers.includes(n)), [], `${text}: never a viewer's`);
    eq(route({ ...SAM, care: "view" }, text, { state: [...state] }).sel.active.filter((n) => hers.includes(n)).sort(), ["mom_nutrition", "mom_status"], `${text}: her reads only, for view`);
  }
  eq(predictGroups({ said: "Robin said hi", carePerson: "Robin" }), ["mom"], "her name alone");
  eq(predictGroups({ said: "Robin said hi", carePerson: null }), [], "no name without her page");
  ok(predictGroups({ said: "Took the Examplex", context: [stateLine], carePerson: "Robin" }).includes("mom"), "her medicine from her line");
  ok(!predictGroups({ said: "Took the bottle", context: [stateLine], carePerson: "Robin" }).includes("mom"), "not every word of her line");
  const closedLoad = toolDisclosure(toolsFor(ALEX, { care: false }), { window: [], vo: COPY.v, lastStep: 5 }).tools[LOAD_TOOLS] as unknown as { inputSchema: { jsonSchema: { properties: { groups: { items: { enum: string[] } } } } } };
  ok(!closedLoad.inputSchema.jsonSchema.properties.groups.items.enum.includes("mom"), "load_tools doesn't offer her page while it's closed");
});

check("a viewer never gets a write tool, whatever the message", () => {
  const allowed = new Set([...Object.keys(toolsFor(VI)), LOAD_TOOLS]);
  for (const text of [...PLAIN, "Robin took ibuprofen", "she weighs 9 lb", "pumped 3 oz", "invite my sister", "forget that", "I put her down in the bassinet"]) {
    const { sel } = route(VI, text);
    for (const n of sel.active) {
      ok(allowed.has(n), `${text}: ${n} is a viewer's`);
      ok(CHAT_CARDS.has(n) || READ_ONLY.get(n) === true, `${text}: ${n} only reads`);
    }
  }
});

check("invites and access changes only for owners; everyone can ask who's in the family", () => {
  const people = groupNames("people");
  const said = "invite my sister sam@example.com";
  eq(route(ALEX, said).sel.active.filter((n) => people.includes(n)), people, "an owner");
  eq(route(SAM, said).sel.active.filter((n) => people.includes(n)), ["list_people"], "a member");
  eq(route(VI, said).sel.active.filter((n) => people.includes(n)), ["list_people"], "a viewer");
  ok(route(ALEX, "make Sam an owner").sel.active.includes("change_access"), "make an owner");
  ok(route(ALEX, "who has access?").sel.active.includes("list_people"), "who has access");
});

check("other groups' words: health, more logging, the app, memories", () => {
  const cases: [string, ToolGroup][] = [
    ["she weighs 8 lb 2 oz", "health"], ["temp 99.1 rectal", "health"], ["gave her vitamin D", "health"], ["add a question for the pediatrician about her rash", "health"],
    ["pumped 3 oz", "log_more"], ["tummy time 10 minutes", "log_more"], ["first smile today!", "log_more"], ["add a note: made-up note", "log_more"],
    ["show me a chart of feeds this week", "app"], ["is it normal for a newborn to sneeze a lot?", "app"], ["switch the units to metric", "app"], ["find the last time she had gas drops", "app"],
    ["that's not true anymore, she's off formula", "memory_admin"], ["you remembered that wrong", "memory_admin"],
  ];
  for (const [text, group] of cases) ok(route(ALEX, text).d.predicted.includes(group), `${text} → ${group}`);
  eq(predictGroups({ said: "gave her vitamin D" }), ["health", "mom"], "a medicine is hers or June's until someone says, hers less surely");
  eq(predictGroups({ said: "Robin took ibuprofen", carePerson: "Robin" }), ["mom", "health"], "named, hers is as sure as any");
  const search = route(ALEX, "find the last time she had gas drops").sel;
  eq([search.groups, search.dropped], [["health", "app"], ["mom"]], "at the ceiling, what a medicine only implies goes first");
});

// ── what the window already holds ────────────────────────────────────────

check("groups called in the window stay: a growth log earlier keeps health for a diaper", () => {
  const { sel } = route(ALEX, DIAPERS[0], { before: earlier(1, "log_growth", { weight_kg: 4 }) });
  eq(sel.groups, ["health"], "health stays");
  eq(route(ALEX, DIAPERS[0], { before: earlier(1, "maple_status") }).sel.groups, [], "a core call keeps nothing more");
});

check("what an older message in the window pointed to stays, so the next turn sends the same set and its prefix stays cached", () => {
  const before: ChatMessage[] = [userMessage("msg_u1", "gave her vitamin D", LINE), { id: "msg_a1", role: "assistant", parts: [{ type: "text", text: "made-up reply" }] }];
  const first = route(ALEX, "gave her vitamin D").sel;
  const next = route(ALEX, DIAPERS[0], { before }).sel;
  eq([first.groups, next.groups], [["mom", "health"], ["mom", "health"]], "the same groups, called or not");
  eq(next.active, first.active, "the same tools, in the same order");
  const tryLine = "Bassinet try t12 running: laid down at 2:10 AM (5 min ago) by Alex; try 1 tonight.";
  eq(readWindow([userMessage("msg_u1", "she woke up", LINE, [tryLine]), userMessage("msg_u2", DIAPERS[0], LINE)]).recent.get("sleep"), 0, "an older message's [App] lines count too");
  eq(readWindow([userMessage("msg_u1", "Robin said hi", LINE), userMessage("msg_u2", DIAPERS[0], LINE)], { carePerson: "Robin" }).recent.get("mom"), 0, "and her name");
});

check("load_tools in the window keeps the groups it loaded; a viewer's window keeps only their own", () => {
  eq(route(ALEX, DIAPERS[0], { before: earlier(1, LOAD_TOOLS, { groups: ["people", "not_a_group"] }) }).sel.groups, ["people"], "people stays");
  eq(readWindow([...earlier(1, LOAD_TOOLS, { groups: ["people", "not_a_group"] }), userMessage("msg_new", "made-up", LINE)]).recent.get("people"), 1, "its window index");
  const vi = route(VI, DIAPERS[0], { before: earlier(1, "invite_person", { email: "x@example.com" }) }).sel;
  ok(!vi.active.includes("invite_person"), "the window never adds a tool the person doesn't have");
});

check("a continuation keeps what its own turn already used", () => {
  const asked: ChatMessage = {
    id: "msg_a2",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "tool-invite_person", toolCallId: "call_2", state: "approval-requested", input: { email: "sam@example.com", access: "member" }, approval: { id: "appr_2" } },
    ] as ChatMessage["parts"],
  };
  const window = [...earlier(1, "log_growth"), userMessage("msg_u2", "invite sam@example.com", LINE), asked];
  const shape = readWindow(window);
  eq([[...shape.turn], [...shape.recent.keys()], shape.said], [["people"], ["health"], "invite sam@example.com"], "this turn's and earlier");
  const d = toolDisclosure(toolsFor(ALEX), { window, vo: COPY.v, lastStep: 5 });
  ok(d.select(0, []).groups.includes("people"), "people stays");
  const answered: ChatMessage = { id: "msg_a3", role: "assistant", parts: [{ type: "tool-ask_user", toolCallId: "call_q", state: "output-available", input: { question: "Whose?", options: [] }, output: { status: "answered", answer: "Robin's" } }] as ChatMessage["parts"] };
  eq(readWindow([userMessage("msg_u3", "log 400 mg of ibuprofen", LINE), answered]).said, "log 400 mg of ibuprofen\nRobin's", "an answer to its question counts as theirs");
});

// ── the ceiling ──────────────────────────────────────────────────────────

check("past the ceiling the least recently used group goes, never core and never one used this turn", () => {
  const sizes = definitionSizes(toolDisclosure(toolsFor(ALEX), { window: [], vo: COPY.v, lastStep: 5 }).tools);
  const core = groupNames("core").filter((n) => n in sizes);
  const three = selectTools({ sizes, predicted: ["mom", "health", "log_more"] });
  eq([three.groups, three.dropped], [["mom", "health"], ["log_more"]], "three named at once: the last in group order goes");
  ok(three.tokens <= TOOL_CEILING, `${three.tokens} under the ceiling`);
  const older = selectTools({ sizes, predicted: ["mom"], recent: new Map<ToolGroup, number>([["log_more", 0], ["app", 2], ["memory_admin", 4]]) });
  eq([older.groups, older.dropped], [["mom", "app", "memory_admin"], ["log_more"]], "the oldest goes first");
  const newer = selectTools({ sizes, predicted: ["mom"], recent: new Map<ToolGroup, number>([["app", 0], ["log_more", 2], ["memory_admin", 4]]) });
  eq([newer.groups, newer.dropped], [["mom", "log_more", "memory_admin"], ["app"]], "by when, not by size");
  const kept = selectTools({ sizes, kept: GROUP_ORDER, predicted: ["mom"] });
  eq([kept.active.length, kept.dropped], [Object.keys(sizes).length, []], "used this turn: all of them stay, even past the ceiling");
  ok(core.every((n) => kept.active.includes(n) && three.active.includes(n) && older.active.includes(n)), "core always");
  const kept2 = selectTools({ sizes, kept: ["mom", "health"], predicted: ["log_more", "app"] });
  eq([kept2.groups, kept2.dropped], [["mom", "health"], ["log_more", "app"]], "what was used this turn wins over what's predicted");
});

check("with nothing used this turn, a first step never passes the ceiling, whoever is signed in", () => {
  const subsets = (1 << GROUP_ORDER.length) - 1;
  for (const [label, tools] of [
    ["owner", toolsFor(ALEX)],
    ["owner, closed", toolsFor(ALEX, { care: false })],
    ["owner, before the birth", toolsFor(ALEX, { born: false })],
    ["member", toolsFor(SAM)],
    ["her own account", toolsFor(SAM, { self: true })],
    ["viewer", toolsFor(VI)],
  ] as const) {
    const sizes = definitionSizes(toolDisclosure(tools, { window: [], vo: COPY.v, lastStep: 5 }).tools);
    for (let mask = 0; mask <= subsets; mask++) {
      const predicted = GROUP_ORDER.filter((_, i) => mask & (1 << i));
      const recent = new Map(GROUP_ORDER.filter((_, i) => !(mask & (1 << i))).map((g, i) => [g, i] as const));
      const sel = selectTools({ sizes, predicted, recent });
      ok(sel.tokens <= TOOL_CEILING, `${label} ${predicted}: ${sel.tokens}`);
    }
  }
});

check("when all of a person's tools fit, they all go, so nothing can miss (a viewer's do)", () => {
  const tools = toolsFor(VI);
  for (const text of [DIAPERS[0], "made-up question"]) eq(route(VI, text).sel.active.sort(), [...Object.keys(tools), LOAD_TOOLS].sort(), text);
});

// ── load_tools and misses, end to end ────────────────────────────────────

type Chunk = Record<string, unknown>;
const USAGE = { inputTokens: { total: 20_000, noCache: 2_000, cacheRead: 18_000, cacheWrite: 0 }, outputTokens: { total: 200, text: 180, reasoning: 20 } };
const finish = (unified: string): Chunk => ({ type: "finish", finishReason: { unified, raw: unified }, usage: USAGE });
const say = (t: string): Chunk[] => [{ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: t }, { type: "text-end", id: "t1" }, finish("stop")];
/** A call as a streaming provider sends it: the input as it comes, then the whole call. */
const callOf = (id: string, toolName: string, input: unknown): Chunk[] => [
  { type: "tool-input-start", id, toolName },
  { type: "tool-input-delta", id, delta: JSON.stringify(input) },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
];

/** `tools` with `name` run by a stand-in that says it saved, counted in `ran`. */
function stubbed(tools: ToolSet, ran: string[], ...names: string[]): ToolSet {
  const out = { ...tools };
  for (const name of names) {
    out[name] = {
      ...tools[name],
      execute: async (): Promise<ChatToolOutput> => {
        ran.push(name);
        return { ok: true, write: true, text: `Saved #12: made-up ${name}.`, saved: [{ id: 12, line: `Saved #12: made-up ${name}.` }] };
      },
    } as ToolSet[string];
  }
  return out;
}

async function turn(tools: ToolSet, steps: Chunk[][], opts: { text?: string; stepsDone?: number } = {}) {
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const script = steps[n++];
      if (!script) return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...say("…")] as never[] }) };
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...script] as never[] }) };
    },
  });
  const saved: ChatMessage[] = [];
  const rows: { tokens: { prompt: number }; finishReason: string | null }[] = [];
  const waits: Promise<unknown>[] = [];
  const res = await chatTurn({
    model,
    modelKey: GLM,
    price: priceFor(GLM)!,
    tools,
    viewer: false,
    care: true,
    copy: COPY,
    messages: [userMessage("msg_u1", opts.text ?? "made-up question", LINE)],
    responseId: "msg_r1",
    crisis: false,
    stepsDone: opts.stepsDone,
    deps: { save: async (m) => void saved.push(structuredClone(m)), record: async (u) => void rows.push(u), release: async () => {}, report: () => {}, waitUntil: (p) => void waits.push(p) },
  });
  const body = await res.text();
  await Promise.all(waits);
  await new Promise((r) => setTimeout(r, 20));
  const sent = (i: number) => (model.doStreamCalls[i]?.tools ?? []).map((t) => t.name);
  return { model, saved, rows, body, sent, calls: () => model.doStreamCalls.length };
}

type Part = { type: string; toolCallId?: string; state?: string; output?: ChatToolOutput };
const partsOf = (m: ChatMessage) => m.parts as unknown as Part[];
const health = groupNames("health");

async function e2e() {
  await checkAsync("load_tools loads a group for the rest of the reply, then the model calls it", async () => {
    const ran: string[] = [];
    const t = await turn(stubbed(toolsFor(ALEX), ran, "log_growth"), [
      callOf("call_load", LOAD_TOOLS, { groups: ["health"] }),
      callOf("call_growth", "log_growth", { weight_kg: 4.1 }),
      say("Saved her weight."),
    ]);
    eq(t.calls(), 3, "three steps");
    ok(!t.sent(0).includes("log_growth") && t.sent(0).includes(LOAD_TOOLS), "not sent until loaded");
    ok(health.every((n) => t.sent(1).includes(n) && t.sent(2).includes(n)), "the whole group, for the rest of the reply");
    eq(ran, ["log_growth"], "ran once");
    eq(t.sent(1), TOOL_ORDER.filter((n) => t.sent(1).includes(n)), "core first, then the group, in the map's order");
    const load = partsOf(t.saved[0]).find((p) => p.type === `tool-${LOAD_TOOLS}`)!;
    eq([load.state, load.output?.ok, load.output?.write], ["output-available", true, false], "a quiet result the tab shows nothing for");
    ok(load.output!.text.startsWith(`Loaded for the rest of this reply: ${health.join(", ")}.`), load.output!.text);
  });

  await checkAsync("load_tools never loads a tool the person can't have", async () => {
    const t = await turn(toolsFor(SAM, { care: false }), [callOf("call_load", LOAD_TOOLS, { groups: ["mom", "people", "not_a_group"] }), say("Done.")]);
    const load = partsOf(t.saved[0]).find((p) => p.type === `tool-${LOAD_TOOLS}`)!;
    eq(load.output!.text, "Loaded for the rest of this reply: list_people. Not available to this person: mom. No group called not_a_group.", "what it says");
    ok(t.sent(1).includes("list_people"), "list_people loaded");
    ok(!t.sent(1).some((n) => ["invite_person", "change_access", "remove_person", "cancel_invite", ...groupNames("mom")].includes(n)), "nothing that isn't theirs");
  });

  await checkAsync("a call to a tool its step didn't send loads that group, and the model calls it again", async () => {
    const ran: string[] = [];
    const t = await turn(stubbed(toolsFor(ALEX), ran, "log_growth"), [
      callOf("call_miss", "log_growth", { weight_kg: 4.1 }),
      callOf("call_again", "log_growth", { weight_kg: 4.1 }),
      say("Saved her weight."),
    ]);
    eq(t.calls(), 3, "three steps");
    ok(!t.sent(0).includes("log_growth") && t.sent(1).includes("log_growth"), "sent from the next step");
    eq(ran, ["log_growth"], "only the second call ran");
    const results = t.model.doStreamCalls[1].prompt.flatMap((m) => (m.role === "tool" ? m.content : []));
    const missed = results.find((r) => r.type === "tool-result" && r.toolCallId === "call_miss") as { output?: unknown } | undefined;
    eq(missed?.output, { type: "error-text", value: notLoadedNow("log_growth") }, "the model reads why, in place of the SDK's error");
    const parts = partsOf(t.saved[0]).filter((p) => p.type === "tool-log_growth");
    eq(parts.map((p) => [p.toolCallId, p.state]), [["call_miss", "output-available"], ["call_again", "output-available"]], "both saved, neither an error");
    eq(parts[0].output, notLoadedOutput("log_growth"), "the miss as a quiet result");
    ok(!t.body.includes("tool-input-error") && !t.body.includes("tool-output-error"), "the phone never got an error card for it");
    ok(!partsOf(t.saved[0]).some((p) => p.state === "output-error"), "no error part saved");
  });

  await checkAsync("a call to a tool the person doesn't have loads nothing and stays the SDK's error", async () => {
    const t = await turn(toolsFor(SAM), [callOf("call_invite", "invite_person", { email: "x@example.com", access: "member" }), say("An owner can invite people.")]);
    eq(t.calls(), 2, "the model still got its next step");
    ok(!t.sent(1).includes("invite_person"), "never loaded for a member");
    const part = partsOf(t.saved[0]).find((p) => p.toolCallId === "call_invite");
    eq([part?.type, part?.state], ["tool-invite_person", "output-error"], "an error, as before");
  });

  await checkAsync("a miss on the last step stays that step's error: nothing is left to call it again", async () => {
    const t = await turn(toolsFor(ALEX), [callOf("call_late", "log_growth", { weight_kg: 4.1 })], { stepsDone: CHAT_MAX_STEPS - 1 });
    eq(t.calls(), 1, "one step");
    ok(!t.sent(0).includes("ask_user") && t.sent(0).includes(LOAD_TOOLS), "the last step drops ask_user, keeps load_tools");
    const part = partsOf(t.saved[0]).find((p) => p.toolCallId === "call_late");
    eq(part?.state, "output-error", "the error card: that step didn't finish");
  });

  await checkAsync("the prefix and in-flight estimates count only the tools a step sends", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n++;
        throw new Error("made-up stream failure");
      },
    });
    const rows: { tokens: { prompt: number }; finishReason: string | null }[] = [];
    const tools = toolsFor(ALEX);
    const res = await chatTurn({
      model, modelKey: GLM, price: priceFor(GLM)!, tools, viewer: false, care: true, copy: COPY, messages: [userMessage("msg_u1", DIAPERS[0], LINE)], responseId: "msg_r1", crisis: false,
      deps: { save: async () => {}, record: async (u) => void rows.push(u), release: async () => {}, report: () => {}, waitUntil: () => {} },
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    ok(n >= 1, "the model was asked");
    const est = rows.find((r) => r.finishReason === "unfinished")?.tokens.prompt ?? 0;
    const sizes = definitionSizes(toolDisclosure(tools, { window: [], vo: COPY.v, lastStep: 5 }).tools);
    const instructions = Math.ceil(JSON.stringify(systemBlocks({ viewer: false, care: true, model: GLM, copy: COPY })).length / 3);
    const coreTokens = definitionTokens(sizes, groupNames("core").filter((x) => x in sizes));
    ok(est >= instructions + coreTokens, `${est} counts the instructions and core (${instructions} + ${coreTokens})`);
    ok(est < instructions + definitionTokens(sizes, Object.keys(sizes)) - 10_000, `${est} leaves out the groups it didn't send`);
  });
}

e2e().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
