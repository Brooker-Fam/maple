import { json, readJson, withMember } from "@/lib/maple/api";
import { deviceOf } from "@/lib/maple/device";
import { applyChatSetting, SettingActionError } from "@/lib/maple/chat/settings-actions";

export const dynamic = "force-dynamic";

/** A card tap, never a model instruction. Local phone preferences also work for viewers. */
export const POST = withMember("POST /api/maple/chat/settings", async (request, member, fam) => {
  try {
    return json(await applyChatSetting(fam, member, await readJson(request), deviceOf(request)));
  } catch (error) {
    if (error instanceof SettingActionError) return json({ error: error.message, code: "setting_changed" }, error.status);
    throw error;
  }
});
