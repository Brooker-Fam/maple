import { existsSync } from "node:fs";
import sharp from "sharp";
import { answerPost } from "../src/lib/maple/chat/post";
import { chatModel } from "../src/lib/maple/chat/caps";
import { familyPostDeps } from "../src/lib/maple/chat/family-deps";
import { uploadChatImage } from "../src/lib/maple/chat/image-store";
import { loadRecentMessages } from "../src/lib/maple/chat/history";
import { freshDb, seedFamilies, sql } from "./tenancy/harness";
import type { FamilyCtx } from "../src/lib/maple/family";
import type { Member } from "../src/lib/maple/types";
import type { ChatMessage } from "../src/lib/maple/chat/types";
import type { ChatImage } from "../src/lib/maple/chat/images";

type Scenario = { id: string; say: string; drawings: string[]; size?: number; tools?: boolean; check: (reply: string, messages: ChatMessage[]) => boolean; followup?: { say: string; check: (reply: string) => boolean } };

const labels = ["VELORA", "NIMBLET", "ORBINA", "TAVILO", "ZEPARA", "QUENDI", "MOLVEX", "RUZANA"];
const codes = ["AZ17", "BX28", "CY39", "DW46", "EV58", "FU63", "GT74", "HS85"];
const includesAll = (reply: string, values: string[]) => values.every((value) => reply.toUpperCase().includes(value));

async function runTurn(fam: FamilyCtx, member: Member, threadId: string, say: string, images: ChatImage[], tools: boolean) {
  const waits: Promise<unknown>[] = [];
  const errors: string[] = [];
  const model = chatModel();
  const deps = familyPostDeps(fam, member, { model, modelKey: model, device: null, now: new Date(), report: (error) => { errors.push(error.message); }, waitUntil: (promise) => { waits.push(promise); } });
  deps.lifecycle = undefined;
  if (!tools) deps.tools = () => ({});
  const response = await answerPost({ threadId, message: { role: "user", parts: [{ type: "text", text: say }, ...images] } }, member, deps);
  const stream = await response.text();
  await Promise.all(waits);
  const messages = await loadRecentMessages(fam, threadId);
  const latest = messages.findLast((message) => message.role === "assistant");
  const reply = latest?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ") ?? "";
  return { passed: response.ok && !errors.length && !stream.includes('"type":"error"'), reply, messages };
}

async function runScenario(scenario: Scenario, fam: FamilyCtx, member: Member): Promise<boolean> {
  const images = [];
  for (const drawing of scenario.drawings) {
    const width = scenario.size ?? 500;
    const height = scenario.size ?? 320;
    const bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${drawing}</svg>`)).png().toBuffer();
    images.push(await uploadChatImage(fam, member, bytes, "image/png"));
  }
  const threadId = `synthetic_image_${scenario.id}`;
  const first = await runTurn(fam, member, threadId, scenario.say, images, !!scenario.tools);
  let passed = first.passed && scenario.check(first.reply, first.messages);
  console.log(`${passed ? "PASS" : "FAIL"} ${scenario.id}`);
  if (passed && scenario.followup) {
    const next = await runTurn(fam, member, threadId, scenario.followup.say, [], !!scenario.tools);
    passed = next.passed && scenario.followup.check(next.reply);
    console.log(`${passed ? "PASS" : "FAIL"} ${scenario.id}_followup`);
  }
  return passed;
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const selected = process.env.MAPLE_IMAGE_EVAL_CASE;
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  const gatewayKey = process.env.AI_GATEWAY_API_KEY;
  for (const name of Object.keys(process.env)) {
    if (/DATABASE|POSTGRES|POSTHOG|RESEND|QSTASH|VAPID|BLOB|GOOGLE|APPLE|MAPLE|MCP_SECRET|ADMIN_PASS/.test(name)) delete process.env[name];
  }
  if (!oidc && !gatewayKey) throw new Error("AI Gateway authentication is required.");
  process.env.MAPLE_SESSION_SECRET = "synthetic-image-evaluation-session";
  await freshDb();
  const { alpha } = await seedFamilies();
  const fam = { familyId: alpha.familyId, status: "active" } as FamilyCtx;
  const member: Member = { email: alpha.owner, role: "owner", display_name: "Avery Example", emoji: null, color: null };
  const cases: Scenario[] = [
    { id: "shapes", say: "Describe the two shapes and their colors in this synthetic test image. Do not log anything.", drawings: ['<rect x="60" y="80" width="150" height="150" fill="#e02020"/><circle cx="365" cy="155" r="80" fill="#2055ee"/>'], check: (reply) => /red/i.test(reply) && /blue/i.test(reply) && /square|rectangle/i.test(reply) && /circle/i.test(reply) },
    { id: "food_label", say: "Read the protein and fiber per serving from this fictional food label. Do not log anything or give dietary advice.", drawings: ['<text x="35" y="65" font-size="30">FICTIONAL TEST FOOD</text><text x="35" y="120" font-size="28">Serving: 1 cup</text><text x="35" y="175" font-size="28">Protein: 17 g</text><text x="35" y="230" font-size="28">Fiber: 6 g</text>'], check: (reply) => /17\s*g|17 grams/i.test(reply) && /6\s*g|6 grams/i.test(reply) },
    { id: "diaper_question", say: "This is a synthetic diaper illustration. Can a photo tell me whether the baby is healthy? Do not log anything.", drawings: ['<rect x="80" y="35" width="340" height="250" rx="45" fill="#fafafa" stroke="#aaa" stroke-width="6"/><ellipse cx="250" cy="160" rx="95" ry="70" fill="#b98a19"/>'], check: (reply) => /cannot|can't|can’t|doesn.t|couldn.t|not.*tell|not.*determine|not.*diagnos/i.test(reply) && /photo|image|illustration/i.test(reply) },
    {
      id: "batch", size: 1600, tools: true,
      say: "First call maple_status to read the current saved status. Then list only the invented label from each of these eight synthetic pictures, in photo order. Do not list their small codes yet. Do not log or change anything.",
      drawings: labels.map((label, index) => `<rect x="100" y="100" width="1400" height="1400" rx="100" fill="hsl(${index * 41},70%,90%)"/><circle cx="800" cy="450" r="170" fill="hsl(${index * 41},70%,40%)"/><text x="800" y="950" text-anchor="middle" font-family="sans-serif" font-size="150" font-weight="bold">${label}</text><text x="800" y="1200" text-anchor="middle" font-family="sans-serif" font-size="90">${codes[index]}</text>`),
      check: (reply, messages) => includesAll(reply, labels) && messages.some((message) => message.parts.some((part) => part.type === "tool-maple_status" && part.state === "output-available" && typeof part.output === "object" && part.output !== null && "ok" in part.output && part.output.ok === true)),
      followup: { say: "Reread the eight photos. In photo order, list each invented label followed by its small code. Do not log anything.", check: (reply) => includesAll(reply, labels) && includesAll(reply, codes) },
    },
  ];
  const scenarios = selected ? cases.filter((scenario) => scenario.id === selected) : cases;
  if (!scenarios.length) throw new Error("Unknown image evaluation case.");
  let failed = 0;
  for (const scenario of scenarios) if (!(await runScenario(scenario, fam, member))) failed++;
  const usage = await sql("SELECT COUNT(*)::int AS steps, MAX(input_tokens + cache_read_tokens + cache_write_tokens)::int AS peak_prompt, SUM(cost_micro_usd)::text AS cost FROM maple_ai_usage WHERE thread_id LIKE 'synthetic_image_%'");
  console.log(`Image evaluation: ${scenarios.length - failed}/${scenarios.length} passed; ${usage[0].steps} model steps; ${usage[0].peak_prompt ?? "0"} peak prompt tokens; ${usage[0].cost ?? "0"} micro-dollars.`);
  if (failed) process.exitCode = 1;
}

main().catch((error: Error) => { console.error(`${error.name}: image evaluation could not complete`); process.exitCode = 1; });
