import { tool, zodSchema } from "ai";
import { DESTINATION_LABELS, destinationAllowed, navigationInputSchema } from "./navigation";
import type { ChatToolOutput } from "./types";

export function openScreenTool(opts: { viewer: boolean }) {
  return tool({
    description: "Show a button opening an existing app screen: today, history, moments, family_settings, phone_preferences, baby_profile, pediatrician (doctor contacts), notifications, doctor_questions, mom_medicines (her medicine list), add_photo (the moment/photo editor), or help. Use this for settings or actions that need their existing form. The person taps the button; this does not navigate automatically, save anything, turn on notifications, schedule reminders, or grant access. Never claim the screen is already open.",
    inputSchema: zodSchema(navigationInputSchema),
    execute: async ({ destination }): Promise<ChatToolOutput> => destinationAllowed(destination, opts.viewer)
      ? { ok: true, write: false, text: `A button to open ${DESTINATION_LABELS[destination]} is shown. Nothing changes until the person opens the screen and uses its controls.`, navigation: { v: 1, destination } }
      : { ok: false, write: false, text: "That screen isn't available with view-only access." },
    toModelOutput: ({ output }) => ({ type: output.ok ? "text" as const : "error-text" as const, value: output.text }),
  });
}
