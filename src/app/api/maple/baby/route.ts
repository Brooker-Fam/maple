import { BadRequest, Forbidden, json, readJson, withMember } from "@/lib/maple/api";
import { getBaby, updateBaby, type BabyPatch } from "@/lib/maple/store";
import { isDayKey } from "@/lib/maple/time";
import { checkLogSwitches } from "@/lib/maple/validate";

export const dynamic = "force-dynamic";

function num(v: unknown, label: string, min: number, max: number): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequest(`${label} looks off`);
  return n;
}

/**
 * PATCH /api/maple/baby — profile edits and the big one: "She's here!"
 * (born_at + birth measurements). Any family member can update it.
 */
export const PATCH = withMember("PATCH /api/maple/baby", async (request, me) => {
  const body = await readJson<Record<string, unknown>>(request);
  const baby = await getBaby();
  const patch: BabyPatch = {};

  if ("name" in body) {
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 80) throw new BadRequest("Name is required");
    patch.name = name;
  }
  if ("nickname" in body) {
    const nick = String(body.nickname ?? "").trim();
    patch.nickname = nick ? nick.slice(0, 40) : null;
  }
  if ("due_date" in body) {
    if (body.due_date !== null && !isDayKey(body.due_date)) throw new BadRequest("due_date must be YYYY-MM-DD");
    patch.due_date = body.due_date as string | null;
  }
  if ("born_at" in body) {
    if (body.born_at === null) patch.born_at = null;
    else {
      const t = typeof body.born_at === "string" ? Date.parse(body.born_at) : NaN;
      if (Number.isNaN(t)) throw new BadRequest("born_at must be an ISO timestamp");
      if (t > Date.now() + 10 * 60_000) throw new BadRequest("Birth time is in the future");
      patch.born_at = new Date(t).toISOString();
    }
  }
  if ("birth_weight_g" in body) patch.birth_weight_g = num(body.birth_weight_g, "Birth weight", 400, 7000);
  if ("birth_length_cm" in body) patch.birth_length_cm = num(body.birth_length_cm, "Birth length", 25, 65);
  if ("birth_head_cm" in body) patch.birth_head_cm = num(body.birth_head_cm, "Head circumference", 20, 45);
  if ("settings" in body) {
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
      throw new BadRequest("settings must be an object");
    }
    // Only the keys sent are changed (null removes one); the store merges them
    // in SQL, acks included, so concurrent saves from two phones both stick.
    const incoming = { ...(body.settings as Record<string, unknown>) };
    if ("acks" in incoming) {
      const acks = incoming.acks;
      delete incoming.acks;
      if (acks && typeof acks === "object" && !Array.isArray(acks)) {
        // A handful per tap; times normalized to ISO so SQL can always cast them.
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(acks as Record<string, unknown>).slice(0, 20)) {
          const t = typeof v === "string" ? Date.parse(v) : NaN;
          if (k.length <= 120 && Number.isFinite(t)) clean[k] = new Date(t).toISOString();
        }
        patch.acks = clean;
      }
    }
    // Bottles and Pumping (Family → On Today) are switches: true, false, or null for the default.
    try {
      checkLogSwitches(incoming);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : "settings look off");
    }
    if ("admin_as" in incoming) {
      // An owner can have the site admin login (the calendar connector) log as
      // themselves, or switch that off. Never as someone else.
      if (me.role !== "owner" || me.email === "admin") throw new Forbidden("Only an owner signed in with Google can change that");
      if (incoming.admin_as !== null && incoming.admin_as !== me.email) throw new BadRequest("That can only be set to yourself");
    }
    // Acks are capped and pruned separately, so they don't count toward the limit.
    const { acks: _acks, ...rest } = { ...baby.settings, ...incoming };
    void _acks;
    if (JSON.stringify(rest).length > 8000) throw new BadRequest("settings too large");
    patch.settings = incoming;
  }

  return json({ baby: await updateBaby(baby.id, patch) });
}, { write: true });
