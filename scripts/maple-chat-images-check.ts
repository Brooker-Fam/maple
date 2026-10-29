import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { query } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { deleteChats } from "../src/lib/maple/chat/history";
import type { ChatMessage } from "../src/lib/maple/chat/types";

process.env.DATABASE_URL = "pglite:chat-images";
process.env.MAPLE_SESSION_SECRET = "synthetic-chat-image-check-secret";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
globalThis.fetch = async () => { throw new Error("External requests are forbidden in image checks"); };
const fam = { familyId: 1 };
const otherFam = { familyId: 2 };
const member = { email: "synthetic-image-user@example.test", role: "member" as const };
const viewer = { ...member, role: "viewer" as const };
const other = { ...member, email: "synthetic-other-user@example.test" };
let failures = 0;

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const modules = () => Promise.all([import("../src/lib/maple/chat/images"), import("../src/lib/maple/chat/image-store")]);
const sharpModule = async () => (await import("sharp")).default;
const source = async () => (await sharpModule())({ create: { width: 24, height: 24, channels: 3, background: "#71959c" } }).png().toBuffer();
const imageId = (url: string) => new URL(url, "https://example.test").searchParams.get("id")!;
const message = (images: ChatMessage["parts"]): ChatMessage => ({ id: randomUUID(), role: "user", parts: images });

async function thread(images: ChatMessage["parts"], asViewer = false) {
  const id = randomUUID();
  const m = message(images);
  await query("INSERT INTO maple_chat_threads (family_id, id, member, model, viewer_only) VALUES (1, $1, $2, 'synthetic-model', $3)", [id, member.email, asViewer]);
  await query("INSERT INTO maple_chat_messages (family_id, id, thread_id, member, seq, role, parts) VALUES (1, $1, $2, $3, 1, 'user', $4::jsonb)", [m.id, id, member.email, JSON.stringify(m.parts)]);
  return m;
}

async function main() {
  await migrate();
  await query("INSERT INTO maple_families (id, timezone, status) VALUES (2, 'America/New_York', 'active') ON CONFLICT DO NOTHING");
  await check("image references accept only canonical private JPEG URLs", async () => {
    const [c] = await modules();
    const valid = { type: "file", mediaType: "image/jpeg", url: `/api/maple/chat/images?id=${randomUUID()}` };
    assert.deepEqual(c.parseChatImage(valid), valid);
    assert(c.isChatImage(valid));
    for (const url of ["https://example.test/photo.jpg", "data:image/jpeg;base64,AA==", valid.url + "&x=1", valid.url + "#fragment", valid.url.toUpperCase(), valid.url.replace("id=", "id=%"), "/api/maple/photo?id=1"]) assert.equal(c.parseChatImage({ ...valid, url }), null);
    for (const value of [null, { ...valid, mediaType: "image/png" }, { ...valid, type: "text" }, { ...valid, filename: "private-name.jpg" }]) assert.equal(c.parseChatImage(value), null);
  });
  await check("normalization strips metadata, bounds pixels and bytes, rejects malformed files", async () => {
    const [c, s] = await modules();
    const sharp = await sharpModule();
    const raw = await sharp({ create: { width: 2000, height: 1800, channels: 3, background: "#71959c" } }).withMetadata({ orientation: 6 }).png().toBuffer();
    const normalized = await s.normalizeChatImage(raw, "image/png");
    const meta = await sharp(normalized).metadata();
    assert.equal(meta.format, "jpeg");
    assert(Math.max(meta.width!, meta.height!) <= c.CHAT_IMAGE_MAX_DIMENSION);
    assert(normalized.length <= c.CHAT_IMAGE_MAX_BYTES);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    await assert.rejects(s.normalizeChatImage(Buffer.from("synthetic nonimage"), "image/jpeg"));
    await assert.rejects(s.normalizeChatImage(raw, "image/jpeg"));
    await assert.rejects(s.normalizeChatImage(Buffer.alloc(c.CHAT_IMAGE_SOURCE_MAX_BYTES + 1), "image/png"));
    const tooLarge = new Request("https://example.test", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=synthetic", "content-length": String(c.CHAT_IMAGE_SOURCE_MAX_BYTES + 100000) }, body: "small" });
    await assert.rejects(s.readChatImageUpload(tooLarge));
    const oversizedStream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(c.CHAT_IMAGE_SOURCE_MAX_BYTES + 100000)); controller.close(); } });
    const streamed = new Request("https://example.test", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=synthetic" }, body: oversizedStream, duplex: "half" } as RequestInit);
    await assert.rejects(s.readChatImageUpload(streamed));
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(await source())], { type: "image/png" }), "synthetic.png");
    const uploaded = await s.readChatImageUpload(new Request("https://example.test", { method: "POST", body: form }));
    assert.equal(uploaded.mediaType, "image/png");
    assert(uploaded.bytes.byteLength > 0);
  });
  await check("stored photos enforce family, member and viewer access and never persist data URLs", async () => {
    const [, s] = await modules();
    const image = await s.uploadChatImage(fam, member, await source(), "image/png");
    await s.validateChatImages(fam, member, [image]);
    for (const [scope, user] of [[otherFam, member], [fam, other], [fam, viewer]] as const) {
      await assert.rejects(s.validateChatImages(scope, user, [image]));
      await assert.rejects(s.readChatImage(scope, user, imageId(image.url)));
      await assert.rejects(s.resolveChatImages(scope, user, [message([image])]));
    }
    const original = message([image]);
    const [resolved] = await s.resolveChatImages(fam, member, [original]);
    assert(resolved.parts.some((part) => part.type === "file" && part.url.startsWith("data:image/jpeg;base64,")));
    assert.equal(original.parts[0].type === "file" && original.parts[0].url, image.url);
    await assert.rejects(s.validateChatImages(fam, member, Array(9).fill(image)));
    await assert.rejects(s.resolveChatImages(fam, member, [message([{ ...image, url: "https://example.test/private.jpg" }])]));
    await assert.rejects(s.validateChatImages(fam, member, [{ ...image, url: `/api/maple/chat/images?id=${randomUUID()}` }]));
  });
  await check("model photo history preserves an entire eight-photo batch and omits older images", async () => {
    const [, s] = await modules();
    const images = await Promise.all(Array.from({ length: 10 }, async () => s.uploadChatImage(fam, member, await source(), "image/png")));
    await s.validateChatImages(fam, member, images.slice(2));
    const messages = [message(images.slice(0, 2)), message(images.slice(2))];
    const resolved = await s.resolveChatImages(fam, member, messages);
    assert.equal(resolved.flatMap((m) => m.parts).filter((p) => p.type === "file").length, 8);
    assert.equal(resolved.at(-1)!.parts.filter((p) => p.type === "file").length, 8);
    assert(resolved[0].parts.every((p) => p.type === "text"));
  });
  await check("unused drafts expire after seven days while referenced photos survive", async () => {
    const [, s] = await modules();
    const expired = await s.uploadChatImage(fam, member, await source(), "image/png");
    const kept = await s.uploadChatImage(fam, member, await source(), "image/png");
    await thread([kept]);
    await query("UPDATE maple_chat_images SET created_at = NOW() - INTERVAL '8 days' WHERE id = ANY($1::text[])", [[imageId(expired.url), imageId(kept.url)]]);
    await assert.rejects(s.readChatImage(fam, member, imageId(expired.url)));
    assert((await s.readChatImage(fam, member, imageId(kept.url))).byteLength > 0);
    await s.pruneDraftChatImages();
    assert.equal((await query("SELECT id FROM maple_chat_images WHERE id = $1", [imageId(expired.url)]))?.length, 0);
    assert.equal((await query("SELECT id FROM maple_chat_images WHERE id = $1", [imageId(kept.url)]))?.length, 1);
  });
  await check("daily upload quotas survive deletion and serialize concurrent final slots", async () => {
    const [, s] = await modules();
    await query("UPDATE maple_chat_image_uploads SET uploads = 39 WHERE family_id = 1 AND member = $1", [member.email]);
    const bytes = await source();
    const attempts = await Promise.allSettled([s.uploadChatImage(fam, member, bytes, "image/png"), s.uploadChatImage(fam, member, bytes, "image/png")]);
    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((a) => a.status === "rejected").length, 1);
    await deleteChats(fam, member.email, false);
    await assert.rejects(s.uploadChatImage(fam, member, bytes, "image/png"));
  });
  await check("chat deletion removes only the member's role-accessible photos", async () => {
    const [, s] = await modules();
    await query("DELETE FROM maple_chat_image_uploads");
    const own = await s.uploadChatImage(fam, member, await source(), "image/png");
    const viewerImage = await s.uploadChatImage(fam, viewer, await source(), "image/png");
    const foreign = await s.uploadChatImage(fam, other, await source(), "image/png");
    await thread([own]);
    await thread([viewerImage], true);
    await deleteChats(fam, member.email, true);
    await assert.rejects(s.readChatImage(fam, viewer, imageId(viewerImage.url)));
    assert((await s.readChatImage(fam, member, imageId(own.url))).byteLength > 0);
    await deleteChats(fam, member.email, false);
    await assert.rejects(s.readChatImage(fam, member, imageId(own.url)));
    assert((await s.readChatImage(fam, other, imageId(foreign.url))).byteLength > 0);
    await migrate();
  });
  await check("deleting chat prevents a pending upload from saving afterward", async () => {
    const [, s] = await modules();
    await deleteChats(fam, member.email, false);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(await source())], { type: "image/png" }), "synthetic.png");
    const encoded = new Request("https://example.test", { method: "POST", body: form });
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    const request = new Request("https://example.test", { method: "POST", headers: encoded.headers, body, duplex: "half" } as RequestInit);
    const pending = s.receiveChatImage(fam, member, request);
    for (let i = 0; i < 100 && !request.bodyUsed; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert(request.bodyUsed);
    await deleteChats(fam, member.email, false);
    writer.enqueue(bytes);
    writer.close();
    await assert.rejects(pending);
    assert.equal((await query("SELECT id FROM maple_chat_images WHERE family_id = 1 AND member = $1", [member.email]))?.length, 0);
  });
  await check("photo routes require consent and current ownership, disable caches, and reject quotas before buffering", async () => {
    const route = await import("../src/app/api/maple/chat/images/route");
    const auth = await import("../src/lib/maple/auth");
    const { acceptConsent } = await import("../src/lib/maple/consent");
    await query("DELETE FROM maple_chat_image_uploads");
    for (const user of [member, other]) await query("INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (1, $1, 'member', NOW()) ON CONFLICT (family_id, email) DO UPDATE SET role = 'member'", [user.email]);
    const cookie = (email = member.email) => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(email, 1))}`;
    const post = async (signedIn = true) => {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(await source())], { type: "image/png" }), "synthetic.png");
      return new NextRequest("https://example.test/api/maple/chat/images", { method: "POST", headers: signedIn ? { cookie: cookie() } : {}, body: form });
    };
    assert.equal((await route.POST(await post(false))).status, 401);
    const missingTerms = await route.POST(await post());
    assert.equal(missingTerms.status, 403);
    assert.equal((await missingTerms.json()).code, "terms");
    await acceptConsent(fam, member.email, "chat");
    const uploaded = await route.POST(await post());
    assert.equal(uploaded.status, 201);
    const { image } = await uploaded.json();
    const url = new URL(image.url, "https://example.test");
    const photo = await route.GET(new NextRequest(url, { headers: { cookie: cookie() } }));
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get("content-type"), "image/jpeg");
    assert.equal(photo.headers.get("cache-control"), "private, no-store");
    assert.equal((await route.GET(new NextRequest(url))).status, 401);
    assert.equal((await route.GET(new NextRequest(url, { headers: { cookie: cookie(other.email) } }))).status, 404);
    assert.equal((await route.GET(new NextRequest(url, { headers: { cookie: cookie(), "x-maple-family": "2" } }))).status, 409);
    await query("UPDATE maple_members SET role = 'viewer' WHERE family_id = 1 AND email = $1", [member.email]);
    assert.equal((await route.GET(new NextRequest(url, { headers: { cookie: cookie() } }))).status, 404);
    await query("UPDATE maple_chat_image_uploads SET uploads = 40 WHERE family_id = 1 AND member = $1", [member.email]);
    const denied = await post();
    assert.equal((await route.POST(denied)).status, 429);
    assert.equal(denied.bodyUsed, false);
  });
  if (failures) throw new Error(`${failures} chat image checks failed`);
  console.log("PASS all chat image checks (synthetic data only)");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
