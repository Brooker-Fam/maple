import assert from "node:assert/strict";
import { CHAT_DESTINATIONS, destinationAllowed, navigationCardSchema, navigationInputSchema } from "../src/lib/maple/chat/navigation";
import { openScreenTool } from "../src/lib/maple/chat/navigation-tools";
import type { ChatToolOutput } from "../src/lib/maple/chat/types";

async function main() {
  assert(!navigationInputSchema.safeParse({ destination: "https://example.test" }).success);
  assert(!navigationInputSchema.safeParse({ destination: "today", url: "https://example.test" }).success);
  assert(!navigationCardSchema.safeParse({ v: 1, destination: "unknown" }).success);
  for (const viewer of [false, true]) {
    const tool = openScreenTool({ viewer });
    for (const destination of CHAT_DESTINATIONS) {
      const result = await tool.execute!({ destination }, { toolCallId: "synthetic-open-screen", messages: [], context: {} }) as ChatToolOutput;
      assert.equal(result.ok, destinationAllowed(destination, viewer));
      assert.equal(result.write, false);
      assert.deepEqual(result.navigation, result.ok ? { v: 1, destination } : undefined);
    }
  }
  assert(!destinationAllowed("add_photo", true));
  assert(!destinationAllowed("mom_medicines", true));
  console.log("PASS navigation: closed destinations, no URLs, role restrictions, read-only cards");
}
void main();
