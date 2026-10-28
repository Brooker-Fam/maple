import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CareEntry, UnitSystem } from "../types";
import { formatTemp, formatVolume } from "../units";

/** Care entry references stay separate from baby entry IDs, even when their numbers match. */
export type ChatCareReceipt = { id: number; line: string; action: "saved" | "updated" | "deleted" | "restored" };
export type ChatToolError = { kind: "validation" | "access" | "conflict" | "unavailable" | "unknown" };

/** The current record supplies its kind and values, including maternal nutrition. */
export function careReceiptDetails(entry: CareEntry, units: UnitSystem): { title: string; description: string | null | undefined } {
  switch (entry.kind) {
    case "dose": return { title: `${entry.data.name}${entry.data.skipped ? " skipped" : ""}`, description: entry.data.dose };
    case "temp": return { title: "Temperature", description: formatTemp(entry.data.temp_c, units) };
    case "question": return { title: "Question for her OB", description: entry.note };
    case "food": return { title: entry.data.meal === "snack" ? "Snack" : "Meal", description: entry.data.description };
    case "drink": return { title: entry.data.name, description: entry.data.amount_ml == null ? "Amount not recorded" : formatVolume(entry.data.amount_ml, units) };
  }
}

const careId = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^c[1-9]\d*$/.test(value)) return null;
  const id = Number(value.slice(1));
  return Number.isSafeInteger(id) ? id : null;
};

/** Only structured results authorize a card; prose alone never creates an action. */
export function careReceiptOutput(res: CallToolResult): { careReceipts?: ChatCareReceipt[] } {
  if (res.isError) return {};
  const sc = (res.structuredContent ?? {}) as Record<string, unknown>;
  const entry = sc.entry && typeof sc.entry === "object" ? sc.entry as Record<string, unknown> : null;
  const id = careId(sc.id) ?? careId(entry?.id);
  const action = sc.deleted === true ? "deleted" : sc.restored === true ? "restored" : sc.updated === true ? "updated" : sc.created === true ? "saved" : null;
  if (id == null || !action) return {};
  const text = res.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
  const line = text.split("\n").find((value) => new RegExp(`^(?:Saved|Updated|Deleted|Restored) c${id}: `).test(value));
  return { careReceipts: [{ id, action, line: line ?? "Saved care entry" }] };
}

/** Tool diagnostics are for the model. Cards show bounded, useful recovery text. */
export function chatToolErrorText(error: ChatToolError | undefined, write: boolean): string {
  switch (error?.kind) {
    case "validation": return "Some details need checking before this can continue.";
    case "access": return "This action isn't available with your current access.";
    case "conflict": return "This entry changed. Check its latest details before trying again.";
    case "unavailable": return write ? "Couldn't confirm this change. Check the log before trying again." : "Couldn't load that information. Please try again.";
    default: return write ? "Couldn't confirm this change. Check the log before trying again." : "That step didn't finish. Please try again.";
  }
}
