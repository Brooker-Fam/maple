import { jsonSchema, NoSuchToolError, tool, type ModelMessage, type ToolSet } from "ai";
import type { ChatMessage, ChatToolOutput } from "./types";
import type { Voice } from "../voice";

/**
 * Progressive tool disclosure for the in-app chat. Every step resends the
 * instructions and the tool definitions, and all of them together no longer
 * leave room under STEP_PROMPT_LIMIT (caps.ts), so each step sends the core
 * tools and only the groups this turn points to: what the newest message and
 * its [App] lines are about, the groups of tool calls still in the model
 * window and what its older messages pointed to (so the set, and its cached
 * prefix, stays the same from turn to turn), and whatever the model loads
 * with load_tools or calls without it (a miss loads that tool's group for
 * the next step). The definitions sent
 * stay under TOOL_CEILING; past it, the least recently used group goes,
 * never core and never one used this turn. Gating stays where it was
 * (`allowed` in tools.ts): this only picks from the person's own tools.
 * Connected apps over MCP still get every tool. No server imports: the
 * checks run this.
 */

export const LOAD_TOOLS = "load_tools";

/**
 * Every chat tool's place, in the order they're sent (TOOL_ORDER): core
 * first, always, then each group. A chat tool missing here fails the chat's
 * check; at run time it rides with core, so it never vanishes.
 */
export const TOOL_GROUPS = {
  core: [
    "maple_status", "log_feed", "log_diaper", "log_sleep", "start_timer", "stop_timer", "switch_side", "pause_nursing", "fix_nursing_time", "reopen_timer",
    "log_many", "update_entry", "delete_entry", "restore_entry", "undo_last", "list_entries", "daily_summary", "record_birth",
    "ask_user", "show_help", "recall_memories", "save_memory", LOAD_TOOLS,
  ],
  mom: ["mom_status", "log_mom_medicine", "log_mom_temperature", "add_mom_question", "fix_mom_entry", "log_mom_food", "log_mom_drink", "mom_nutrition"],
  health: ["log_growth", "log_medicine", "log_temperature", "log_vitals", "add_doctor_question", "list_doctor_questions"],
  sleep: ["sleep_plan", "set_sleep_plan", "bassinet_try", "holding", "sleep_goal"],
  log_more: ["log_pump", "log_note", "log_activity", "log_moment", "get_moments"],
  app: ["search_entries", "show_chart", "get_settings", "propose_setting", "open_screen", "web_search"],
  people: ["list_people", "invite_person", "change_access", "remove_person", "cancel_invite"],
  memory_admin: ["correct_memory", "resolve_memory", "archive_memory"],
} as const satisfies Record<string, readonly string[]>;

export type ToolGroup = Exclude<keyof typeof TOOL_GROUPS, "core">;

/** The groups in the order they're sent and offered. */
export const GROUP_ORDER = Object.keys(TOOL_GROUPS).filter((g): g is ToolGroup => g !== "core");

/** Mapped before the tool exists (the sleep plan's coaching tool), so it lands in its group the day it does. */
export const PLANNED_TOOLS: ReadonlySet<string> = new Set(["sleep_goal"]);

const GROUP_OF = new Map<string, "core" | ToolGroup>(
  Object.entries(TOOL_GROUPS).flatMap(([group, names]) => names.map((name) => [name, group as "core" | ToolGroup] as const))
);

/** A tool's place in the map, or null for one that isn't mapped (it rides with core). */
export const groupOf = (name: string): "core" | ToolGroup | null => GROUP_OF.get(name) ?? null;

/** The order tools are sent in (the SDK's toolOrder): core in a stable order, then the groups in GROUP_ORDER. */
export const TOOL_ORDER: readonly string[] = Object.values(TOOL_GROUPS).flat();

/**
 * The most the definitions sent in one step may be, in tokens by the chars/3
 * measure (definitionTokens): core is about 14K, so this leaves room for the
 * largest group with another or two. The chat's check proves a first step
 * at this ceiling, with the instructions, the window, the newest message and
 * a whole cut tool result, stays under STEP_PROMPT_LIMIT.
 */
export const TOOL_CEILING = 24_000;

/** Each tool's definition as the step sends it ([name, description, input schema]), in characters. */
export function definitionSizes(tools: ToolSet): Record<string, number> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [name, JSON.stringify([name, t.description, (t.inputSchema as { jsonSchema?: unknown }).jsonSchema]).length])
  );
}

/** Those definitions in tokens, by the turn's own estimate (characters / 3). */
export function definitionTokens(sizes: Readonly<Record<string, number>>, names: Iterable<string>): number {
  let chars = 0;
  for (const name of names) chars += (sizes[name] ?? 0) + 1;
  return Math.ceil(chars / 3);
}

// ── what the newest message points to ────────────────────────────────────

/** A medicine is the baby's or hers until someone says whose, so these point to both groups. */
const MEDICINE = /\b(medicines?|meds?|medications?|doses?|dosage|drops|vitamin\s?d|vit\s?d|simethicone|mylicon|gripe water|probiotics?|tylenol|acetaminophen|paracetamol|motrin|advil|ibuprofen|antibiotics?|amoxicillin|ointment|nystatin|famotidine|pepcid|omeprazole|prescriptions?|pharmacy|pills?|tablets?|capsules?|syrup)\b/i;

/**
 * Words that point a message to a group. They lean toward a match: a group
 * sent for nothing costs its definitions, while a missing one costs a step.
 * Plain logging (a feed, a diaper, a nap) stays in core, which has it all.
 */
const GROUP_WORDS: Record<ToolGroup, RegExp[]> = {
  mom: [
    /\b(mom|mommy|mama|momma|mum|mummy|wife|postpartum|post-partum|ob|ob-?gyn|obgyn|midwife|c-?section|incision|stitches|lochia|mastitis)\b/i,
    /\bi\s+(just\s+|also\s+|already\s+)?(took|ate|drank)\b/i,
    /\b(can|could|should|may|when can)\s+i\s+(take|have|eat|drink)\b/i,
    /\bmy\s+(meds?|medicines?|medications?|pills?|doses?|pain\w*|temp|temperature|fever|incision|stitches|bleeding|recovery|ob|doctor|lunch|breakfast|dinner|snack|meal|food|drinks?|water|nutrition|protein|fiber)\b/i,
    /\b(nutrition|protein|fiber|fibre|calories|hydrat\w*|breakfast|lunch|dinner|snacks?|meals?|smoothie|oatmeal|salad|sandwich)\b/i,
  ],
  health: [
    /\b(weigh\w*|weight|lbs?|pounds?|kilos?|kg|grams?|length|height|inches|head (size|circumference)|percentiles?|growth|growing|grew|measure\w*|scale)\b/i,
    /\b(temp|temps|temperature|fever\w*|febrile|thermometer|degrees|rectal|armpit|axillary|forehead|vitals?|heart ?rate|pulse|bpm|breathing|breaths|respirat\w*|oxygen|spo2|jaundice\w*|bilirubin|skin|rash\w*)\b/i,
    /\d\s?°/,
    MEDICINE,
    /\b(doctor|doctors|dr|pediatrician|paediatrician|pediatric\w*|peds|appointment|appt|check-?up|well[- ](baby|visit|child)|lactation|ibclc)\b/i,
  ],
  sleep: [
    /\b(bassinet|crib|cot|sleep (plan|goal|training|coach\w*|schedule|routine|question|tips?|advice)|cry it out|ferber\w*|self[- ]?sooth\w*|sooth\w*|settl(e|ing)|drowsy|sleepy|nodding off|dozing|contact (nap|naps|sleep)|held sleep|transfer\w*|wake windows?|overtired)\b/i,
    /\b(holding|hold (her|him|them|the baby)|held (her|him|them)|hand ?off|handoff|hand (her|him|them) (off|over)|take over|taking over|my turn|your turn|shifts?|partner)\b/i,
    /\b(put|putting|lay|laid|laying) (her|him|them|the baby) down\b/i,
    /\b(stage|goal|goals|back to work)\b/i,
    // How parents talk about the nights: shifts and protected sleep, held sleep, unsafe places they ask about, and being worn out.
    /\b(protected (sleep|window|time|stretch)|roster|split (the )?nights?|night (shifts?|duty|plan|schedule)|who'?s (up|on)|(first|second|late|early) shift|on track|dream ?feed|back at work|return(ing)? to work|(maternity|paternity|parental) leave|leave ends)\b/i,
    /\b(only|won'?t|doesn'?t) (sleeps?|naps?|settles?)\b|\b(sleeps?|naps?|slept|sleeping|napping) (only )?(on|with) (me|us|him|her|dad|mom)\b/i,
    /\b(our|my|the) bed\b|co-?sleep\w*|bed-?shar\w*|\bswing\b|recliner|couch|sofa|armchair|let (her|him|them) cry|\bcio\b/i,
    /\b(exhausted|sleep[- ]deprived|so tired|(need|get) (some )?sleep|(rough|hard|long|bad) night|night was (rough|hard|long|bad)|up all night|(my|his|her) window)\b/i,
    // Before a plan or goal exists: held naps on someone, waiting before going in, sleep gear, whose turn it is, and being worn out.
    /\bon (my|his|her|your|our) (chest|lap|shoulder)\b|going in when|wait\w* before (going in|picking)|swaddl\w*|sleep ?sack|snoo|white noise|mattress|whose turn|turns tonight|tag[- ]team|\bswap\b(?! (sides?|breasts?|to the (left|right)))|wrecked|so (he|she|i|we) can (sleep|rest)/i,
  ],
  log_more: [
    /\b(pump\w*|expressed|expressing|haakaa|let-?down|freezer stash|milk stash)\b/i,
    /\b(note|notes|jot|write (this|that|it)? ?down|journal)\b/i,
    /\b(tummy|bath|bathed|bathtime|baths)\b/i,
    /\b(moments?|milestones?|keepsake|first (smile|laugh|bath|outing)|smiled|smiling|giggl\w*|laugh\w*|rolled over|photos?|pictures?|pics?)\b/i,
  ],
  app: [
    /\b(search\w*|find|look(ing)? (up|for)|lookup|last time|chart|charts|graph\w*|plot|trends?|compare|comparison|patterns?|history|this week|last week|past (week|month))\b/i,
    /\b(settings?|preferences?|units?|metric|imperial|dark mode|light mode|theme|night (look|mode)|time ?zone|notifications?|notify|reminders?|remind|nickname|rename|phone number|contacts?|address|open|show me|take me|go to|screen|button)\b/i,
    /\b(normal|typical|usual|average|common|recommend\w*|guidelines?|guidance|aap|cdc|nhs|research|stud(y|ies)|safe|safety|recalls?|news|web|online|internet|google|near me|opening hours|store|brand|product|buy)\b/i,
    /\bhow (much|many|often|long) (should|do|does|is)\b/i,
  ],
  people: [
    /\b(invit\w*|access|permissions?|owners?|admins?|members?|viewers?|view[- ]only|photos[- ]only|revoke|people|who('s| is| can| has))\b/i,
    /\b(remove|kick) \w+ (from|out)\b/i,
    /\badd \w+( \w+)? to (the )?(app|family|maple|account|log)\b/i,
    /\bshare (maple|the app|the log|access)\b/i,
  ],
  memory_admin: [
    /\b(memor(y|ies)|remember\w*|forget|forgot|anymore|no longer|archive\w*|resolve\w*|outdated|out of date)\b/i,
    /\b(that's|that is|you're|you are|it's|it is) (wrong|not right|not true|old)\b/i,
  ],
};

/** A sleep question (how she's sleeping, why, what to try) is the sleep plan's, which the instructions send them to. */
const SLEEP_WORD = /\b(sleep\w*|slept|asleep|naps?|napping|bedtime|nights?)\b/i;
const QUESTION = /\?|\b(how|why|what|should|tips?|advice|help|enough|longer|better|normal)\b/i;

/**
 * [App] state lines that mean the family uses the sleep plan (sleep/mcp.ts
 * sleepStatus): a try in the bassinet, someone holding her, a plan, an active
 * sleep goal or last night's check-ins. A family with a plan or a goal gets
 * the sleep tools on every message, so "yes, mine held" or a check-in answer
 * never costs a load_tools step (the group is small next to the ceiling).
 */
const SLEEP_STATE = /^(Bassinet try \S+ running\b|Holding: |Sleep plan: |Sleep goals: |Check-ins for last night: )/;

/** Her next medicine's [App] line names it (logState in mcp-tools.ts), so a message naming it is about her page. */
const NEXT_MEDICINE = /next medicine: (.+)$/;
const NOT_A_MEDICINE = new Set(["after", "since", "last", "next", "today", "tonight", "until", "every", "hours", "minutes", "doses", "left", "time", "times", "taken"]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordIn = (text: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/**
 * The groups the newest message points to, surest first: what its own words
 * name (`said`, never the [App] lines' names) and the [App] state lines
 * stored with it (`context`) say, in GROUP_ORDER, then her page when a
 * medicine word only implies it (a medicine is the baby's or hers until
 * someone says whose). `carePerson`: her name, when the family has a care
 * page (Voice.hasMom). Groups this person has no tools in come to nothing
 * later.
 */
export function predictGroups(input: { said: string; context?: readonly string[]; carePerson?: string | null }): ToolGroup[] {
  const { said } = input;
  const named = new Set<ToolGroup>();
  for (const group of GROUP_ORDER) if (GROUP_WORDS[group].some((re) => re.test(said))) named.add(group);
  if (SLEEP_WORD.test(said) && QUESTION.test(said)) named.add("sleep");
  if (input.carePerson && wordIn(said, input.carePerson)) named.add("mom");
  for (const line of input.context ?? []) {
    if (SLEEP_STATE.test(line)) named.add("sleep");
    const medicine = NEXT_MEDICINE.exec(line)?.[1];
    if (medicine) {
      const names = (medicine.match(/\p{L}[\p{L}'-]{3,}/gu) ?? []).filter((w) => !NOT_A_MEDICINE.has(w.toLowerCase()));
      if (names.some((name) => wordIn(said, name))) named.add("mom");
    }
  }
  const out = GROUP_ORDER.filter((g) => named.has(g));
  if (MEDICINE.test(said) && !named.has("mom")) out.push("mom");
  return out;
}

// ── what the model window already holds ──────────────────────────────────

/** The newest message as the selection reads it, and the groups the rest of the window holds. */
export type WindowShape = {
  /** The person's own words this turn: the newest user message's text, and their answers to its questions. */
  said: string;
  /** The [App] state lines stored with the newest user message. */
  context: string[];
  /**
   * Groups from before this turn, each with the window index of the newest
   * message that called one of its tools or pointed to it (higher is newer):
   * the calls keep their definitions present, and what older messages pointed
   * to keeps the set the same from one turn to the next, so its prefix stays
   * cached.
   */
  recent: Map<ToolGroup, number>;
  /** Groups called earlier in this turn (an approval's or a question's continuation). */
  turn: Set<ToolGroup>;
};

const textOf = (m: ChatMessage) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []));
const stateOf = (m: ChatMessage) => m.parts.flatMap((p) => (p.type === "data-context" ? [...((p.data as { state?: string[] }).state ?? [])] : []));

type LooseToolPart = { type: string; toolName?: unknown; input?: unknown; state?: unknown; output?: unknown };

/** The tool a UI part called, or null for a part that isn't a call. */
function calledName(part: LooseToolPart): string | null {
  if (part.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : null;
  return part.type.startsWith("tool-") ? part.type.slice(5) : null;
}

/** The groups a call touches: its tool's, or for load_tools the groups it loaded. */
export function groupsOfCall(name: string, input: unknown): ToolGroup[] {
  if (name === LOAD_TOOLS) return requestedGroups(input).groups;
  const group = groupOf(name);
  return group && group !== "core" ? [group] : [];
}

/** load_tools' input as far as it names real groups. */
export function requestedGroups(input: unknown): { groups: ToolGroup[]; unknown: string[] } {
  const raw = (input as { groups?: unknown } | null)?.groups;
  const asked = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((g): g is string => typeof g === "string").slice(0, 20);
  const groups = GROUP_ORDER.filter((g) => asked.includes(g));
  return { groups, unknown: asked.filter((g) => !(GROUP_ORDER as readonly string[]).includes(g)) };
}

/** `carePerson`: her name, as for predictGroups, for what older messages pointed to. */
export function readWindow(window: readonly ChatMessage[], opts: { carePerson?: string | null } = {}): WindowShape {
  const last = window.findLastIndex((m) => m.role === "user");
  const recent = new Map<ToolGroup, number>();
  const turn = new Set<ToolGroup>();
  const answers: string[] = [];
  window.forEach((message, i) => {
    if (message.role === "user" && i < last) {
      for (const group of predictGroups({ said: textOf(message).join("\n"), context: stateOf(message), carePerson: opts.carePerson })) recent.set(group, i);
    }
    for (const raw of message.parts) {
      const part = raw as LooseToolPart;
      const name = calledName(part);
      if (!name) continue;
      for (const group of groupsOfCall(name, part.input)) {
        if (i > last) turn.add(group);
        else recent.set(group, i);
      }
      const out = part.output as { status?: unknown; answer?: unknown } | null | undefined;
      if (i > last && name === "ask_user" && out?.status === "answered" && typeof out.answer === "string") answers.push(out.answer);
    }
  });
  const user = last >= 0 ? window[last] : null;
  const said = [...(user ? textOf(user) : []), ...answers].join("\n");
  return { said, context: user ? stateOf(user) : [], recent, turn };
}

// ── one step's tools ─────────────────────────────────────────────────────

export type Selection = {
  /** The tools to send, in TOOL_ORDER (unmapped ones after, with core). */
  active: string[];
  /** The groups sent, in GROUP_ORDER. */
  groups: ToolGroup[];
  /** Groups wanted but left out to stay under the ceiling, least recently used last. */
  dropped: ToolGroup[];
  /** The active definitions in tokens (definitionTokens). */
  tokens: number;
};

const orderIndex = new Map(TOOL_ORDER.map((name, i) => [name, i]));
const byOrder = (a: string, b: string) => (orderIndex.get(a) ?? Infinity) - (orderIndex.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * One step's tools, from the person's own (`sizes`: every tool they may have
 * this turn, by name, with its definition's size): core always; then the
 * groups used this turn (`kept`: called, loaded or missed), which never go;
 * then the groups the newest message points to (`predicted`, surest first)
 * and those still in the window (`recent`, newest first), while the
 * definitions stay under `ceiling`; past it the least recently used goes
 * first. When all of them fit, all of them go, so nothing can miss.
 */
export function selectTools(input: {
  sizes: Readonly<Record<string, number>>;
  predicted?: readonly ToolGroup[];
  recent?: ReadonlyMap<ToolGroup, number>;
  kept?: Iterable<ToolGroup>;
  ceiling?: number;
}): Selection {
  const { sizes } = input;
  const ceiling = input.ceiling ?? TOOL_CEILING;
  const names = Object.keys(sizes).sort(byOrder);
  const inGroup = (g: ToolGroup) => names.filter((n) => groupOf(n) === g);
  const offered = GROUP_ORDER.filter((g) => inGroup(g).length);
  const all = definitionTokens(sizes, names);
  if (all <= ceiling) return { active: names, groups: offered, dropped: [], tokens: all };

  const core = names.filter((n) => { const g = groupOf(n); return g === "core" || g === null; });
  const kept = new Set([...(input.kept ?? [])].filter((g) => offered.includes(g)));
  const predicted = (input.predicted ?? []).filter((g) => offered.includes(g) && !kept.has(g));
  const recent = input.recent ?? new Map<ToolGroup, number>();
  // This message's groups (surest first) are newer than anything in the window, whose newest calls come next.
  const rank = (g: ToolGroup) => (predicted.includes(g) ? Number.MAX_SAFE_INTEGER - predicted.indexOf(g) : (recent.get(g) ?? -Infinity));
  const wanted = offered
    .filter((g) => !kept.has(g) && (predicted.includes(g) || recent.has(g)))
    .sort((a, b) => rank(b) - rank(a) || GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  const dropped: ToolGroup[] = [];
  const pick = () => new Set<ToolGroup>([...kept, ...wanted]);
  const tokensOf = (groups: Set<ToolGroup>) => definitionTokens(sizes, [...core, ...[...groups].flatMap(inGroup)]);
  while (wanted.length && tokensOf(pick()) > ceiling) dropped.unshift(wanted.pop()!);
  const groups = offered.filter((g) => pick().has(g));
  const active = [...core, ...groups.flatMap(inGroup)].sort(byOrder);
  return { active, groups, dropped, tokens: definitionTokens(sizes, active) };
}

// ── load_tools, and a call to a tool that wasn't sent ────────────────────

/** What each group holds, in a few words, for load_tools' description. */
function groupWords(vo: Voice): Record<ToolGroup, string> {
  return {
    mom: `${vo.mom}'s page: her medicines and doses, temperature, food and drinks, questions for her OB`,
    health: `${vo.name}'s growth, medicine, vitals and temperature, doctor questions`,
    sleep: "the sleep plan, bassinet tries, holding turns, sleep goals and check-ins",
    log_more: "pumping, notes, tummy time and baths, moments",
    app: "finding entries, charts, settings, opening a screen, web search",
    people: "who's in the family, invites and access",
    memory_admin: "correcting, resolving or archiving a memory",
  };
}

const loadedText = (names: string[], skipped: ToolGroup[], unknown: string[]) =>
  [
    names.length ? `Loaded for the rest of this reply: ${names.join(", ")}.` : "Nothing new to load.",
    skipped.length ? `Not available to this person: ${skipped.join(", ")}.` : "",
    unknown.length ? `No group called ${unknown.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

/**
 * load_tools for this person: `offered`, the groups they have tools in;
 * `names`, which of a group's tools they have; `load`, what the turn does
 * with the groups (they stay for the rest of it). It never loads a tool
 * that isn't theirs: those were never in their set. No validate, so a bad
 * group comes back as a result the model can fix, as the MCP tools' do.
 */
export function loadToolsTool(opts: { vo: Voice; offered: readonly ToolGroup[]; names: (group: ToolGroup) => string[]; load: (groups: ToolGroup[]) => void }) {
  const words = groupWords(opts.vo);
  const list = opts.offered.map((g) => `${g} (${words[g]})`).join("; ");
  return tool<{ groups?: unknown }, ChatToolOutput, Record<string, unknown>>({
    description: `Loads more of your tools for the rest of this reply. Groups: ${list}.`,
    inputSchema: jsonSchema<{ groups?: unknown }>({
      type: "object",
      properties: { groups: { type: "array", items: { type: "string", enum: [...opts.offered] }, minItems: 1, description: "The groups to load." } },
      required: ["groups"],
      additionalProperties: false,
    }),
    execute: async (input): Promise<ChatToolOutput> => {
      const { groups, unknown } = requestedGroups(input);
      const usable = groups.filter((g) => opts.offered.includes(g));
      opts.load(usable);
      const names = usable.flatMap(opts.names);
      return { ok: true, write: false, text: loadedText(names, groups.filter((g) => !usable.includes(g)), unknown) };
    },
    toModelOutput: ({ output }: { output: ChatToolOutput }) => ({ type: "text", value: output.text }),
  });
}

/** What the model reads, in the next step, about a call to a tool that wasn't sent: its group is sent now. */
export const notLoadedNow = (name: string) => `${name} wasn't loaded yet, so nothing ran. It's loaded now: call it again with the same arguments.`;

/** The same call as the saved chat keeps it, for later turns: an output the Chat tab shows nothing for. */
export const notLoadedOutput = (name: string): ChatToolOutput => ({ ok: true, write: false, text: `${name} wasn't loaded yet, so nothing ran; it was loaded for the next step.` });

/** The model's next step reads `notLoadedNow` in place of the SDK's "unavailable tool" error for each call that missed. */
export function withMissesExplained(messages: ModelMessage[], missed: ReadonlyMap<string, { name: string }>): ModelMessage[] {
  if (!missed.size) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool") return m;
    const content = m.content.map((part) => {
      const miss = part.type === "tool-result" ? missed.get(part.toolCallId) : undefined;
      if (!miss || part.type !== "tool-result") return part;
      changed = true;
      return { ...part, output: { type: "error-text" as const, value: notLoadedNow(miss.name) } };
    });
    return { ...m, content };
  });
  return changed ? out : messages;
}

// ── one turn ─────────────────────────────────────────────────────────────

type StepCall = { type: string; toolName?: unknown; input?: unknown };

/**
 * One turn's disclosure: the person's tools plus load_tools, and each step's
 * selection. What a step called, loaded or missed stays for the rest of the
 * turn. `vo`: the family's words, for load_tools and her name. `lastStep`:
 * the last step this request may run, after which a miss can't be retried.
 */
export function toolDisclosure(tools: ToolSet, opts: { window: readonly ChatMessage[]; vo: Voice; lastStep: number; ceiling?: number }) {
  const carePerson = opts.vo.hasMom ? opts.vo.mom : null;
  const shape = readWindow(opts.window, { carePerson });
  const base = definitionSizes(tools);
  const has = (group: ToolGroup) => (TOOL_GROUPS[group] as readonly string[]).filter((name) => name in base);
  const offered = GROUP_ORDER.filter((group) => has(group).length);
  const loaded = new Set<ToolGroup>();
  const missed = new Map<string, { name: string }>();
  let step = 0;
  const load = loadToolsTool({ vo: opts.vo, offered, names: has, load: (groups) => groups.forEach((g) => loaded.add(g)) });
  const all: ToolSet = { ...tools, [LOAD_TOOLS]: load };
  const sizes = { ...base, ...definitionSizes({ [LOAD_TOOLS]: load }) };
  const predicted = predictGroups({ said: shape.said, context: shape.context, carePerson });
  return {
    /** Every tool this person may have this turn, for execution, history and the stream; each step sends `select`'s. */
    tools: all,
    sizes,
    predicted,
    /** This step's tools. `steps`: the steps so far, whose calls (and misses) keep their groups. */
    select(stepNumber: number, steps: readonly { content: readonly unknown[] }[]): Selection {
      step = stepNumber;
      const used = new Set<ToolGroup>([...shape.turn, ...loaded]);
      for (const s of steps) {
        for (const raw of s.content) {
          const part = raw as StepCall;
          if (part.type !== "tool-call" || typeof part.toolName !== "string" || !(part.toolName in sizes)) continue;
          for (const group of groupsOfCall(part.toolName, part.input)) used.add(group);
        }
      }
      return selectTools({ sizes, predicted, recent: shape.recent, kept: used, ceiling: opts.ceiling });
    },
    /**
     * The SDK's repairToolCall, which never repairs: it notes a call to one of
     * this person's tools that this step didn't send, while a step is left to
     * call it again (its group comes then). Anything else stays the SDK's
     * error: a tool they don't have, a core one held back (ask_user on the
     * last step), or a miss on the last step, which didn't finish.
     */
    repair: async ({ toolCall, error }: { toolCall: { toolCallId: string; toolName: string }; error: unknown }) => {
      const group = groupOf(toolCall.toolName);
      if (NoSuchToolError.isInstance(error) && step < opts.lastStep && toolCall.toolName in base && group && group !== "core") missed.set(toolCall.toolCallId, { name: toolCall.toolName });
      return null;
    },
    /** The tool a call missed, by its id: the next step has it, so its error card never shows. */
    missOf: (toolCallId: string): string | null => missed.get(toolCallId)?.name ?? null,
    /** The step's messages with each miss's result reading notLoadedNow. */
    explain: (messages: ModelMessage[]) => withMissesExplained(messages, missed),
  };
}

export type ToolDisclosure = ReturnType<typeof toolDisclosure>;
