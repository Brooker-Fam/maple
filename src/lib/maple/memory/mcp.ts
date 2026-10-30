import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureServerException } from "@/lib/posthog-server";
import { memberName } from "../insights";
import { FAMILY_ONE_COPY, READ_ANN, ToolError, VIEWER_MESSAGE, WRITE_ANN, context, fail, ok, type Annotations, type Ctx, type Extra, type ToolCopy } from "../mcp-tools";
import { StoreUnavailable } from "../store";
import { dayKey } from "../time";
import { memoryStatusJson, recallMatches, recallRecord, type Names } from "./policy";
import { correctMemory, endMemory, getMemory, listMemories, memoryContext, MemoryRefused, saveMemory, type MemoryActor } from "./store";
import {
  MEMORY_FACT_MAX,
  MEMORY_KINDS,
  MEMORY_KIND_HINT,
  MemoryInputError,
  memoryRef,
  parseMemoryRef,
  readMemoryInput,
  readSourceText,
  type MemoryRecord,
  type MemoryVia,
} from "./types";

/**
 * Family memories as MCP tools (Moku's recallMemories, saveMemory,
 * correctMemory, resolveMemory and archiveMemory), registered on Maple's
 * server by registerMapleTools, so Maple's own chat and every connected app
 * share them. Reads are open to viewers; writes need a member, and a model's
 * write needs the family's "Let chats save memories" switch on.
 *
 * Memory ids print as m12. A chat turn's writes carry the epoch the turn
 * started with (`ctx.memoryEpoch`): after a Forget or a switch change they're
 * refused, so a turn can't write back what it read before. Memory text is
 * the family's: it's only ever shown as data.
 */

const ROUTE = "/api/maple/mcp";

/** A memory's text as the result sentence quotes it. */
const quoted = (m: Pick<MemoryRecord, "fact">) => `"${m.fact}"`;

const VIA_OF: Record<Ctx["who"]["via"], MemoryVia> = { web: "web", chat: "chat", claude: "claude", chatgpt: "chatgpt", muse: "muse", grok: "grok", mcp: "mcp", shortcut: "mcp", epic: "mcp" };

/** A model's write: the chat's carries the epoch its turn started with, and has none only when the memories couldn't be read then. */
function actorOf(ctx: Ctx): MemoryActor {
  if (ctx.who.via === "chat" && ctx.memoryEpoch == null) throw new ToolError("The family's memories couldn't be read for this message, so nothing was changed. Try again in a minute.");
  return { member: ctx.who.id, via: VIA_OF[ctx.who.via] ?? "mcp", assistant: true, epoch: ctx.who.via === "chat" ? ctx.memoryEpoch : null };
}

const namesOf = (ctx: Pick<Ctx, "members">): Names => (id) => memberName(id, ctx.members);

const today = (ctx: Ctx) => dayKey(ctx.now, ctx.tz);

/** The words for a refused memory write, so the model can put it right or explain. */
function refusedText(err: MemoryRefused): string {
  const cur = err.current;
  switch (err.code) {
    case "capture":
      return "Saving memories from chats is turned off in Settings → Memories, so nothing was changed. If they want it kept, they can add it there themselves.";
    case "epoch":
      return "The family's memories changed since this message arrived (someone used Forget or changed the memory switches), so nothing was changed. If it still matters, ask them to say it again.";
    case "duplicate":
      return cur
        ? `Another current memory already says that: ${memoryRef(cur.id)} (revision ${cur.revision}), ${quoted(cur)}. Nothing was changed; archive one of them if they're the same.`
        : "Another current memory already says that. Nothing was changed.";
    case "changed":
      return cur
        ? cur.status === "active"
          ? `${memoryRef(cur.id)} changed since you read it, so nothing was changed. It now reads ${quoted(cur)} (revision ${cur.revision}). Check it's still what they meant, then try again with revision ${cur.revision}.`
          : `${memoryRef(cur.id)} isn't current anymore (${cur.status === "superseded" ? "it was corrected" : cur.status}), so nothing was changed. Call recall_memories for the current one.`
        : "That memory changed, so nothing was changed. Call recall_memories, then try again.";
    case "missing":
      return "There's no such memory in this family (it may have been forgotten). Nothing was changed; call recall_memories for the current ones.";
  }
}

async function memoryToolError(name: string, err: unknown): Promise<CallToolResult> {
  if (err instanceof ToolError) return fail(err.message);
  if (err instanceof MemoryInputError) return fail(`${err.message.replace(/\.$/, "")}. Nothing was saved; fix that and try again.`);
  if (err instanceof MemoryRefused) return fail(refusedText(err));
  if (err instanceof StoreUnavailable) return fail("Maple's Log can't reach its database right now, so nothing was saved. Try again in a minute.");
  // Its class only: Postgres quotes the row, and a memory is the family's words.
  const scrubbed = new Error(err instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(err.name) ? err.name : "memory_error");
  console.error(`Maple MCP ${name} error: ${scrubbed.message}`);
  await captureServerException(scrubbed, { tool: name, route: ROUTE });
  return fail("Something went wrong inside Maple's Log. Call recall_memories before trying again, so nothing is saved twice.");
}

function addMemoryTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: S; annotations: Annotations; invoking: string; invoked: string; write?: boolean },
  run: (args: ShapeOutput<S>, ctx: Ctx) => Promise<CallToolResult>
) {
  const handler = async (args: ShapeOutput<S>, extra: Extra): Promise<CallToolResult> => {
    try {
      const ctx = await context(extra);
      if (cfg.write && ctx.who.role === "viewer") throw new ToolError(VIEWER_MESSAGE);
      return await run(args, ctx);
    } catch (err) {
      return memoryToolError(name, err);
    }
  };
  server.registerTool(
    name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.inputSchema,
      annotations: { title: cfg.title, ...cfg.annotations },
      _meta: { "openai/toolInvocation/invoking": cfg.invoking, "openai/toolInvocation/invoked": cfg.invoked },
    },
    handler as unknown as ToolCallback<S>
  );
}

/** What a memory change returns: a sentence, and the memory as data (the Chat tab's card reads `memory_change`). */
function changeResult(summary: string, change: { status: "saved" | "supported" | "corrected" | "resolved" | "archived"; memory: MemoryRecord; previous?: MemoryRecord }, ctx: Ctx): CallToolResult {
  const t = today(ctx);
  return ok(summary, {
    memory_change: {
      status: change.status,
      id: memoryRef(change.memory.id),
      revision: change.memory.revision,
      kind: change.memory.kind,
      fact: change.memory.fact,
      ...(change.previous ? { previous_fact: change.previous.fact } : {}),
    },
    memory: recallRecord(change.memory, t, namesOf(ctx)),
  });
}

/** The memory an edit names, read for its current text, checked as current and at the revision the model read. */
async function editTarget(ctx: Ctx, rawId: string, revision: number): Promise<MemoryRecord> {
  const id = parseMemoryRef(rawId);
  if (!id) throw new ToolError(`"${rawId.slice(0, 20)}" isn't a memory id; they look like m12. Call recall_memories for the current ones.`);
  const m = await getMemory(ctx.fam, id);
  if (!m) throw new MemoryRefused("missing");
  if (m.status !== "active" || m.revision !== revision) throw new MemoryRefused("changed", m);
  return m;
}

/** A correction that would leave little of a long memory: say how much, so the model restates what's still true or saves it apart. */
const LONG_FACT = 240;
const KEEP_SHARE = 0.4;

const kindList = MEMORY_KINDS.map((k) => `${k} (${MEMORY_KIND_HINT[k]})`).join(", ");

export function registerMemoryTools(server: McpServer, copy: ToolCopy = FAMILY_ONE_COPY) {
  const vo = copy.v;
  const mom = vo.hasMom ? vo.mom : `${vo.their} mom`;
  const id = () => z.string().max(24).describe('The memory\'s id, like "m12", from family_memories or recall_memories.');
  const revision = () => z.number().int().min(1).describe("The revision you read with that memory; a memory changed since then is refused with its current text.");
  const source = () =>
    z.string().max(1000).nullish().describe("What this rests on: the person's own words when they said it (a bare yes to your suggestion is fine), otherwise a short note of why. Shown with the memory in Settings.");
  const day = (what: string) => z.string().max(10).nullish().describe(`${what} as YYYY-MM-DD in the family's timezone (${copy.tz}).`);

  addMemoryTool(
    server,
    "recall_memories",
    {
      title: "Look up family memories",
      description: `Search what this family asked to have remembered: ${kindList}. Use it when they refer to something said before ("like I told you", "remember..."), ask what you know about a topic, or when a memory may matter and isn't in front of you. Returns up to 8 matches, best first, each with its id and revision (for edits), kind, fact, reason, dates and who said it where. include_history adds memories that ended, were corrected or were set aside; id reads one memory with the versions it replaced. No result doesn't prove it was never said. The current ones are already in family_memories.`,
      inputSchema: {
        query: z.string().max(200).nullish().describe("Words to look for, like formula, bassinet or pediatrician. Leave out to list the newest."),
        kind: z.enum(MEMORY_KINDS).nullish().describe("Only memories of this kind."),
        include_history: z.boolean().nullish().describe("Also memories that ended, were corrected or were set aside."),
        id: z.string().max(24).nullish().describe('One memory\'s id, like "m12", for its full details and earlier versions.'),
      },
      annotations: READ_ANN,
      invoking: "Remembering…",
      invoked: "Memories checked",
    },
    async (a, ctx) => {
      const ctxMem = await memoryContext(ctx.fam, { now: ctx.now, tz: ctx.tz });
      if (!ctxMem.state.use) throw new ToolError("Family memories are turned off in Settings → Memories, so they can't be read.");
      const names = namesOf(ctx);
      const t = ctxMem.today;
      if (a.id) {
        const want = parseMemoryRef(a.id);
        const all = want ? await listMemories(ctx.fam, { history: true }) : [];
        const m = all.find((x) => x.id === want);
        if (!m) return ok(`There's no memory ${a.id.slice(0, 20)} in this family (it may have been forgotten).`, { memories: [], total: 0 });
        const versions: MemoryRecord[] = [];
        for (let p = m.predecessor_id; p != null && versions.length < 10; ) {
          const prev = all.find((x) => x.id === p);
          if (!prev) break;
          versions.push(prev);
          p = prev.predecessor_id;
        }
        const full = { ...recallRecord(m, t, names), ...(m.source_text ? { [m.source_words ? "their_words" : "note"]: m.source_text } : {}) };
        return ok(`${memoryRef(m.id)}: ${quoted(m)}${versions.length ? ` (${versions.length} earlier ${versions.length === 1 ? "version" : "versions"})` : ""}.`, {
          memories: [full],
          ...(versions.length ? { earlier_versions: versions.map((v) => recallRecord(v, t, names)) } : {}),
          total: 1,
        });
      }
      const pool = a.include_history ? await listMemories(ctx.fam, { history: true }) : ctxMem.records;
      const { matches, total } = recallMatches(pool, { query: a.query ?? "", kinds: a.kind ? [a.kind] : [], history: !!a.include_history, today: t });
      const what = a.query?.trim() ? `about "${a.query.trim().slice(0, 60)}"` : a.kind ? `of kind ${a.kind}` : "";
      const summary = matches.length
        ? `${total} ${total === 1 ? "memory" : "memories"} ${what}${total > matches.length ? `, showing the best ${matches.length}` : ""}.`.replace(/ \./, ".").replace(/ ,/, ",")
        : `No ${a.include_history ? "" : "current "}memories ${what || "saved"}.`.replace(/\s+/g, " ").replace(/ \./, ".");
      return ok(summary, { memories: matches.map((m) => recallRecord(m, t, names)), total, ...(total > matches.length ? { hint: "Narrow the words or the kind for the rest." } : {}) });
    }
  );

  addMemoryTool(
    server,
    "save_memory",
    {
      title: "Remember something for the family",
      description: `Save something this family wants kept in mind across conversations, in the turn they say it: ${vo.name}'s feeding plan or a change to it (a formula brand, paced bottles, a pumping schedule), health context they report (an allergy, reflux, instructions from ${vo.name}'s doctor), the sleep setup, a routine or who does what, the care team, or how they like answers. It's shared with everyone in the family, who can see and change it in Settings → Memories, so say what you saved. Don't save one-off events (log those), app settings, guesses or diagnoses nobody reported, or anything about ${mom}'s own health, medicines, food, temperatures, mood or recovery. When it changes or contradicts a current memory, use correct_memory instead. Saving the same text again confirms the one already there. E.g. "remember we're doing paced bottle feeding", "her pediatrician wants her woken to eat every 3 hours until her weight check on Friday" (valid_to that Friday).`,
      inputSchema: {
        kind: z.enum(MEMORY_KINDS).describe(`What it's about: ${kindList}.`),
        fact: z
          .string()
          .min(2)
          .max(MEMORY_FACT_MAX)
          .describe(`One self-contained sentence in the third person that still makes sense months from now without this conversation: name who and what it's about, and keep its limits, numbers and "not"s. Put dates in valid_from, valid_to or review_on, not here. E.g. "${vo.Name} takes Similac Pro-Sensitive formula; regular Similac upset ${vo.their} stomach."`),
        reason: z.string().max(300).nullish().describe("Why, if they said; otherwise leave out."),
        valid_from: day("The first day it applies, if it starts later"),
        valid_to: day("The last day it applies, for something temporary"),
        review_on: day("A day to check it still holds (like the next checkup)"),
        source: source(),
      },
      annotations: WRITE_ANN,
      invoking: "Remembering that…",
      invoked: "Remembered",
      write: true,
    },
    async (a, ctx) => {
      const input = readMemoryInput(a, { assistant: true });
      const { status, memory } = await saveMemory(ctx.fam, input, actorOf(ctx), { text: readSourceText(a.source), words: false });
      return changeResult(
        status === "saved"
          ? `Remembered ${memoryRef(memory.id)} for the family: ${quoted(memory)}. Everyone in the family can see it in Settings → Memories.`
          : `Already remembered as ${memoryRef(memory.id)}: ${quoted(memory)}. Nothing changed.`,
        { status, memory },
        ctx
      );
    }
  );

  addMemoryTool(
    server,
    "correct_memory",
    {
      title: "Correct a family memory",
      description: `Change what a current memory says when they correct it or something about it changed ("she's on the sensitive formula now", "the checkup moved to the 12th"). fact is the whole memory after the change, so keep everything in it that's still true; a new, separate fact is a new memory for save_memory. Fields you leave out keep their values; list any to remove in clear. The old version stays in the memory's history. Take its id and revision from family_memories or recall_memories.`,
      inputSchema: {
        id: id(),
        revision: revision(),
        fact: z.string().min(2).max(MEMORY_FACT_MAX).describe("The whole memory after the change, one or two self-contained sentences."),
        kind: z.enum(MEMORY_KINDS).nullish().describe("A different kind, only if it was filed wrong."),
        reason: z.string().max(300).nullish().describe("A new reason, if they gave one."),
        valid_from: day("A new first day"),
        valid_to: day("A new last day"),
        review_on: day("A new day to check it still holds"),
        clear: z.array(z.enum(["reason", "valid_from", "valid_to", "review_on"])).max(4).nullish().describe("Fields to remove, like valid_to when it no longer ends."),
        source: source(),
      },
      annotations: WRITE_ANN,
      invoking: "Updating that memory…",
      invoked: "Memory updated",
      write: true,
    },
    async (a, ctx) => {
      const old = await editTarget(ctx, a.id, a.revision);
      const clear = new Set<string>(a.clear ?? []);
      const keep = (k: "reason" | "valid_from" | "valid_to" | "review_on", v: string | null | undefined) => (clear.has(k) ? null : v ?? old[k]);
      const input = readMemoryInput(
        {
          kind: a.kind ?? old.kind,
          fact: a.fact,
          reason: keep("reason", a.reason),
          valid_from: keep("valid_from", a.valid_from),
          valid_to: keep("valid_to", a.valid_to),
          review_on: keep("review_on", a.review_on),
        },
        { assistant: true }
      );
      if (old.fact.length >= LONG_FACT && input.fact.length < old.fact.length * KEEP_SHARE) {
        throw new ToolError(
          `${memoryRef(old.id)} is ${old.fact.length} characters and this would leave ${input.fact.length}, dropping most of it. fact is the whole memory after the change: restate everything still true, save a separate fact with save_memory, or archive it if they want it all gone. Nothing was changed.`
        );
      }
      const { memory, previous } = await correctMemory(ctx.fam, { id: old.id, revision: old.revision }, input, actorOf(ctx), { text: readSourceText(a.source), words: false });
      return changeResult(`Changed ${memoryRef(previous.id)} to ${memoryRef(memory.id)}: ${quoted(memory)} (was ${quoted(previous)}).`, { status: "corrected", memory, previous }, ctx);
    }
  );

  addMemoryTool(
    server,
    "resolve_memory",
    {
      title: "Mark a family memory resolved",
      description: `Mark a memory resolved when what it describes has ended ("she's off the reflux medicine", "the tongue tie was fixed", "I'm back at work, so that routine's over"). It stops guiding answers and stays in the memory's history. Only when they say it ended: a symptom getting better isn't a resolution, and never decide a medical question is settled. Take its id and revision from family_memories or recall_memories.`,
      inputSchema: { id: id(), revision: revision() },
      annotations: WRITE_ANN,
      invoking: "Marking it resolved…",
      invoked: "Memory resolved",
      write: true,
    },
    async (a, ctx) => {
      const old = await editTarget(ctx, a.id, a.revision);
      const memory = await endMemory(ctx.fam, { id: old.id, revision: old.revision }, "resolved", actorOf(ctx));
      return changeResult(`Marked ${memoryRef(memory.id)} resolved: ${quoted(memory)}. It stays in the family's memory history.`, { status: "resolved", memory }, ctx);
    }
  );

  addMemoryTool(
    server,
    "archive_memory",
    {
      title: "Set aside a family memory",
      description: "Archive a memory that was wrong, is a duplicate, or no longer helps, when they ask you to drop it or it plainly contradicts what they say now. It stops guiding answers and stays in the memory's history, where they can forget it for good in Settings → Memories. Take its id and revision from family_memories or recall_memories.",
      inputSchema: { id: id(), revision: revision() },
      annotations: WRITE_ANN,
      invoking: "Setting it aside…",
      invoked: "Memory archived",
      write: true,
    },
    async (a, ctx) => {
      const old = await editTarget(ctx, a.id, a.revision);
      const memory = await endMemory(ctx.fam, { id: old.id, revision: old.revision }, "archived", actorOf(ctx));
      return changeResult(`Archived ${memoryRef(memory.id)}: ${quoted(memory)}. It stays in the family's memory history.`, { status: "archived", memory }, ctx);
    }
  );
}

/**
 * maple_status's family_memories for a connected app: the current memories
 * and what the switches mean. Null when they can't be read just now; the
 * status itself never fails over them.
 */
export async function statusMemories(ctx: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const mem = await memoryContext(ctx.fam, { now: ctx.now, tz: ctx.tz });
    return memoryStatusJson(mem, namesOf(ctx), { viewer: ctx.who.role === "viewer" });
  } catch (error) {
    if (!(error instanceof StoreUnavailable)) {
      const scrubbed = new Error(error instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(error.name) ? error.name : "memory_error");
      void captureServerException(scrubbed, { tool: "maple_status", route: ROUTE, part: "memories" });
    }
    return null;
  }
}
