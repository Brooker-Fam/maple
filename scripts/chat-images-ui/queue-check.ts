import assert from "node:assert/strict";
import { emptyQueue, queueScope, readChatQueue, writeChatQueue } from "../../src/components/maple/chat/queue";

const now = Date.parse("2026-10-29T16:00:00Z");
const image = { type: "file", mediaType: "image/jpeg", url: "/api/maple/chat/images?id=11111111-1111-4111-8111-111111111111" };
const batch = Array.from({ length: 8 }, (_, index) => ({ ...image, url: `/api/maple/chat/images?id=00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
const scope = queueScope(99, "alex@example.test");
const item = { requestId: "synthetic-image-message", text: "", images: batch, submittedAt: new Date(now).toISOString(), state: "queued" };
let failures = 0;
function check(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${(error as Error).message}`); }
}
check("eight-photo draft persists", () => {
  const value = { ...emptyQueue(), draftImages: batch };
  writeChatQueue(scope, value as never, storage);
  assert.deepEqual((readChatQueue(scope, storage, now) as typeof value).draftImages, batch);
});
check("eight-photo queued message survives reload without resending", () => {
  storage.setItem(scope, JSON.stringify({ draft: "", items: [item], paused: false }));
  const restored = readChatQueue(scope, storage, now);
  assert.equal(restored.items.length, 1);
  assert.deepEqual((restored.items[0] as typeof item).images, batch);
  assert.equal(restored.paused, true);
});
check("caption and eight photos remain together after interrupted send", () => {
  storage.setItem(scope, JSON.stringify({ draft: "", items: [{ ...item, text: "Describe this made-up meal", state: "sending" }], paused: false }));
  const restored = readChatQueue(scope, storage, now).items[0] as typeof item;
  assert.equal(restored.state, "uncertain");
  assert.deepEqual(restored.images, batch);
});
check("only private references survive storage", () => {
  storage.setItem(scope, JSON.stringify({ draft: "Keep this caption", draftImages: [{ ...image, url: "data:image/jpeg;base64,EXAMPLE" }], items: [], paused: false }));
  const restored = readChatQueue(scope, storage, now) as ReturnType<typeof emptyQueue> & { draftImages?: unknown[]; imageProblem?: string };
  assert.equal(restored.draft, "Keep this caption");
  assert.equal(restored.draftImages?.length ?? 0, 0);
  assert(restored.imageProblem, "Invalid attachment must be reported instead of silently disappearing");
});
check("missing attachments never make interrupted sends safe to retry", () => {
  storage.setItem(scope, JSON.stringify({ draft: "", items: [{ ...item, state: "sending", images: [{ ...image, url: "https://unsafe.example.test/image.jpg" }] }], paused: false }));
  const restored = readChatQueue(scope, storage, now).items[0] as typeof item & { imagesMissing?: boolean };
  assert.equal(restored.state, "uncertain");
  assert.equal(restored.imagesMissing, true);
  storage.setItem(scope, JSON.stringify({ draft: "", items: [restored], paused: true }));
  assert.equal(readChatQueue(scope, storage, now).items.length, 1, "Attachment warnings survive another reload");
});
if (failures) process.exitCode = 1;
