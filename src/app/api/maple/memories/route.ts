import type { NextRequest } from "next/server";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import type { FamilyCtx } from "@/lib/maple/family";
import { correctMemory, endMemory, forgetMemories, listMemories, memoryState, MemoryRefused, saveMemory, setMemorySwitches, type MemoryActor } from "@/lib/maple/memory/store";
import { MemoryInputError, parseMemoryRef, readMemoryInput, type MemoryList } from "@/lib/maple/memory/types";
import { dayKey } from "@/lib/maple/time";
import type { Member } from "@/lib/maple/types";

/**
 * Settings → Memories: the family's memories, every version, and the two
 * switches. GET is for anyone in the family but photos-only guests; POST
 * (add, edit, resolve, archive, forget, forget all, switches) for owners and
 * members. An edit names the revision it was made from: a memory changed
 * since then answers 409 with the memory as it is now, so the page reloads
 * instead of overwriting it. Every answer is the whole list again.
 *
 * Privacy: a memory's words never reach logs or PostHog; a refusal carries
 * its code, and an unexpected error only its class (withMember).
 */

type Body = {
  action?: unknown;
  id?: unknown;
  revision?: unknown;
  memory?: unknown;
  capture?: unknown;
  use?: unknown;
};

async function listFor(fam: FamilyCtx, member: Member): Promise<MemoryList> {
  const [state, records] = await Promise.all([memoryState(fam), listMemories(fam, { history: true })]);
  return { state, today: dayKey(new Date(), fam.tz), records, canEdit: member.role === "owner" || member.role === "member" };
}

function target(body: Body): { id: number; revision: number } {
  const id = parseMemoryRef(body.id);
  const revision = typeof body.revision === "number" && Number.isSafeInteger(body.revision) && body.revision > 0 ? body.revision : null;
  if (!id || !revision) throw new BadRequest("Which memory, and its revision, are needed.");
  return { id, revision };
}

function memoryInput(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequest("The memory is missing.");
  return readMemoryInput(raw as Record<string, unknown>, { assistant: false });
}

const switchValue = (v: unknown) => (typeof v === "boolean" ? v : undefined);

export const GET = withMember("GET /api/maple/memories", async (_request, member, fam) => json(await listFor(fam, member)));

export const POST = withMember(
  "POST /api/maple/memories",
  async (request: NextRequest, member: Member, fam: FamilyCtx) => {
    const body = await readJson<Body>(request);
    const actor: MemoryActor = { member: member.email, via: "web", assistant: false, epoch: null };
    // What they typed in Settings is their own words, so it needs no other source.
    const typed = { text: null, words: true };
    try {
      switch (body.action) {
        case "save":
          await saveMemory(fam, memoryInput(body.memory), actor, typed);
          break;
        case "correct":
          await correctMemory(fam, target(body), memoryInput(body.memory), actor, typed);
          break;
        case "resolve":
        case "archive":
          await endMemory(fam, target(body), body.action === "resolve" ? "resolved" : "archived", actor);
          break;
        case "forget": {
          const id = parseMemoryRef(body.id);
          if (!id) throw new BadRequest("Which memory to forget is needed.");
          await forgetMemories(fam, { id });
          break;
        }
        case "forget_all":
          await forgetMemories(fam, { all: true });
          break;
        case "switches": {
          const capture = switchValue(body.capture);
          const use = switchValue(body.use);
          if (capture === undefined && use === undefined) throw new BadRequest("Which switch to change is needed.");
          await setMemorySwitches(fam, { capture, use });
          break;
        }
        default:
          throw new BadRequest("Unknown memory action.");
      }
    } catch (error) {
      if (error instanceof MemoryInputError) throw new BadRequest(error.message);
      if (error instanceof MemoryRefused) {
        const words =
          error.code === "duplicate"
            ? "Another current memory already says that."
            : error.code === "missing"
              ? "That memory isn't here anymore."
              : "Someone changed that memory just now. Here it is as it is now.";
        return json({ error: words, code: error.code, current: error.current, list: await listFor(fam, member) }, 409);
      }
      throw error;
    }
    return json(await listFor(fam, member));
  },
  { write: true }
);
