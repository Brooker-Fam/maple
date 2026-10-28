import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { careReceiptDetails, careReceiptOutput, chatToolErrorText } from "../src/lib/maple/chat/receipts";
import { nutritionAmountText, nutritionEditData } from "../src/lib/maple/chat/nutrition-edit";
import type { CareNutritionEntry } from "../src/lib/maple/types";
import { ozToMl } from "../src/lib/maple/units";

const result = (structuredContent: Record<string, unknown>, text: string, isError = false): CallToolResult => ({ structuredContent, content: [{ type: "text", text }], isError });
const dose = careReceiptOutput(result({ created: true, entry: { id: "c42" } }, "Saved c42: Example medicine at 8:00 AM."));
assert.deepEqual(dose, { careReceipts: [{ id: 42, action: "saved", line: "Saved c42: Example medicine at 8:00 AM." }] });
assert.equal(careReceiptOutput(result({ created: true, id: "c43" }, "Saved c43: 98.6°F at 9:00 AM.")).careReceipts?.[0].id, 43);
for (const action of ["updated", "deleted", "restored"] as const) {
  const word = action[0].toUpperCase() + action.slice(1);
  assert.equal(careReceiptOutput(result({ [action]: true, id: "c42" }, `${word} c42: Example care entry.`)).careReceipts?.[0].action, action);
}
// Similar prose, a baby/plan identifier, and a possible duplicate must never authorize care actions.
for (const structured of [{}, { created: false, id: "c42" }, { created: true, id: 42 }, { created: true, id: "p42" }, { created: true, id: "c0" }, { created: true, id: "c9007199254740993" }]) {
  assert.deepEqual(careReceiptOutput(result(structured, "Saved c42: A claimed save.")), {});
}
assert.deepEqual(careReceiptOutput(result({ created: true, id: "c42" }, "Saved c42: A claimed save.", true)), {});
assert.equal(careReceiptOutput(result({ created: true, id: "c42" }, "Saved c99: A different entry.")).careReceipts?.[0].line, "Saved care entry");
assert.match(chatToolErrorText(undefined, true), /Couldn't confirm.*Check the log/);
assert.doesNotMatch(chatToolErrorText(undefined, true), /nothing|changed nothing|log_feed|maple_status/);
assert.match(chatToolErrorText({ kind: "validation" }, true), /details need checking/);
assert.match(chatToolErrorText({ kind: "access" }, true), /current access/);
assert.match(chatToolErrorText({ kind: "conflict" }, true), /entry changed/);
assert.match(chatToolErrorText({ kind: "unavailable" }, false), /load that information/);
const base = { id: 44, med_id: null, at: "2026-10-01T14:00:00Z", note: "Synthetic note", private: false, source: "chat" as const, created_by: null, updated_by: null, created_at: "2026-10-01T14:00:00Z", updated_at: "2026-10-01T14:00:00Z" };
const food: CareNutritionEntry = { ...base, kind: "food", data: { description: "Toast and eggs", meal: "meal" } };
const drink: CareNutritionEntry = { ...base, kind: "drink", data: { name: "Water", amount_ml: 237 } };
for (const entry of [food, drink]) {
  assert.equal(careReceiptOutput(result({ created: true, id: "c44", entry }, `Saved c44: ${entry.kind} for Example.`)).careReceipts?.[0].id, 44, "Nutrition structured IDs remain care references even when entry.id is numeric");
  assert.doesNotMatch(careReceiptDetails(entry, "us").title, /OB/);
}
assert.deepEqual(careReceiptDetails(food, "us"), { title: "Meal", description: "Toast and eggs" });
assert.equal(careReceiptDetails({ ...food, data: { ...food.data, meal: "snack" } }, "us").title, "Snack");
assert.equal(careReceiptDetails(drink, "us").description, "8 oz");
assert.equal(careReceiptDetails({ ...drink, data: { name: "Water", amount_ml: 250 } }, "metric").description, "250 ml");
assert.equal(careReceiptDetails({ ...drink, data: { name: "Water", amount_ml: null } }, "us").description, "Amount not recorded");
const draft = { description: "Yogurt", meal: "snack" as const, name: "Tea", amount: nutritionAmountText(drink, "us") };
assert.deepEqual(nutritionEditData(food, draft, "us"), { description: "Yogurt", meal: "snack" });
assert.deepEqual(nutritionEditData(drink, draft, "us"), { name: "Tea", amount_ml: 237 }, "An unchanged rounded amount retains exact source volume");
assert.deepEqual(nutritionEditData(drink, { ...draft, amount: "6" }, "us"), { name: "Tea", amount_ml: ozToMl(6) });
assert.deepEqual(nutritionEditData(drink, { ...draft, amount: "250" }, "metric"), { name: "Tea", amount_ml: 250 });
assert.deepEqual(nutritionEditData(drink, { ...draft, amount: "" }, "us"), { name: "Tea", amount_ml: null });
for (const amount of ["-1", "0", "5001", "bad"]) assert.throws(() => nutritionEditData(drink, { ...draft, amount }, "metric"));
assert.throws(() => nutritionEditData(drink, { ...draft, name: "" }, "us"));
console.log("PASS care receipt authority: saved doses/temperatures, edits, deletes and restores stay in the care domain");
console.log("PASS tool errors: useful recovery copy without schema diagnostics or false no-change assurances");
console.log("PASS nutrition receipts and edits: correct kinds, units, unknown volume and validated precise amounts");
