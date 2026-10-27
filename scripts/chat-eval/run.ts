/**
 * The in-app chat's scenario bench: each scenario in scenarios.ts runs
 * through the chat's real POST and turn against a real model on AI Gateway,
 * with stand-in tools over a made-up log (no database), then is scored.
 *
 *   npx tsx scripts/chat-eval/run.ts --model zai/glm-5.3-flash [--runs 3] [--only id,id] [--concurrency 4] [--out-dir DIR] [--keep-going]
 *
 * Needs AI Gateway auth: VERCEL_OIDC_TOKEN (from `vercel env pull .env.local`)
 * or AI_GATEWAY_API_KEY. Every request carries the chat's own ZDR and
 * no-training options. Prints a table and writes chat-eval-<model>.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHAT_MODEL_DEFAULT } from "../../src/lib/maple/chat/caps";
import { dollars, type StepTokens } from "../../src/lib/maple/chat/prices";
import { play, type Call, type TurnOut } from "./bench";
import { universal, type View } from "./checks";
import { modelPrice } from "./pricing";
import { buildSim, SCENARIOS, type Scenario } from "./scenarios";

const ROOT = resolve(__dirname, "../..");

function args() {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const runs = Number(get("--runs") ?? 1);
  const concurrency = Number(get("--concurrency") ?? 4);
  if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error("--runs and --concurrency take whole numbers");
  return {
    model: get("--model") ?? CHAT_MODEL_DEFAULT,
    runs,
    concurrency,
    only: get("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    outDir: get("--out-dir") ?? process.env.CHAT_EVAL_OUT_DIR ?? tmpdir(),
    keepGoing: a.includes("--keep-going"),
  };
}

function loadEnv() {
  const file = join(ROOT, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
  // The stand-in tools never need it, and nothing here may reach a real log.
  for (const k of Object.keys(process.env)) if (k.startsWith("DATABASE_URL") || k.startsWith("POSTGRES")) delete process.env[k];
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) throw new Error("No AI Gateway auth: run `vercel env pull .env.local` (VERCEL_OIDC_TOKEN) or set AI_GATEWAY_API_KEY.");
}

type Outcome = {
  id: string;
  run: number;
  pass: boolean;
  failed: { check: string; why: string }[];
  latencyMs: number;
  steps: number;
  tokens: StepTokens;
  costMicro: bigint;
  calls: { turn: number; name: string; input: unknown; ok: boolean }[];
  turns: (Omit<TurnOut, "costMicro"> & { costMicro: bigint })[];
  crashed?: string;
};

const sum = (ts: StepTokens[]): StepTokens => ts.reduce((n, t) => ({ prompt: n.prompt + t.prompt, fresh: n.fresh + t.fresh, cacheRead: n.cacheRead + t.cacheRead, cacheWrite: n.cacheWrite + t.cacheWrite, output: n.output + t.output, reasoning: n.reasoning + t.reasoning }), { prompt: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });

const compact = (input: unknown) => JSON.stringify(Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).filter(([, v]) => v != null)));
const callText = (c: Call | Outcome["calls"][number]) => `${c.name}${compact(c.input) === "{}" ? "" : compact(c.input)}${c.ok ? "" : "!"}`;

async function score(s: Scenario, run: number, model: string, price: Awaited<ReturnType<typeof modelPrice>>["price"]): Promise<Outcome> {
  const played = await play({ sim: buildSim(s), turns: s.turns, model, price, care: !!s.care, threadId: `eval_${s.id}_${run}_${Date.now().toString(36)}`.slice(0, 64) });
  const view: View = { ...played, reply: played.turns[played.turns.length - 1].reply };
  const failed: Outcome["failed"] = [];
  for (const c of [...s.expect, ...universal(s.asks)]) {
    let why: string | null;
    try {
      why = c.run(view);
    } catch (e) {
      why = `check threw: ${(e as Error).message}`;
    }
    if (why) failed.push({ check: c.name, why });
  }
  return {
    id: s.id,
    run,
    pass: !failed.length,
    failed,
    latencyMs: played.turns.reduce((n, t) => n + t.latencyMs, 0),
    steps: played.turns.reduce((n, t) => n + t.steps, 0),
    tokens: sum(played.turns.map((t) => t.tokens)),
    costMicro: played.turns.reduce((n, t) => n + t.costMicro, BigInt(0)),
    calls: played.calls.map((c) => ({ turn: c.turn, name: c.name, input: c.input, ok: c.ok })),
    turns: played.turns,
  };
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function table(rows: Outcome[]) {
  const head = `${pad("scenario", 28)} ${pad("run", 3)} ${pad("result", 6)} ${pad("ms", 6)} ${pad("st", 2)} ${pad("in", 7)} ${pad("out", 5)} ${pad("cost", 10)} ${pad("calls", 44)} why`;
  console.log(head);
  console.log("-".repeat(head.length + 20));
  for (const r of rows) {
    const why = r.crashed ?? r.failed.map((f) => `${f.check}: ${f.why}`).join(" | ");
    console.log(`${pad(r.id, 28)} ${pad(String(r.run), 3)} ${pad(r.pass ? "PASS" : "FAIL", 6)} ${pad(String(r.latencyMs), 6)} ${pad(String(r.steps), 2)} ${pad(String(r.tokens.prompt), 7)} ${pad(String(r.tokens.output), 5)} ${pad(dollars(r.costMicro), 10)} ${pad(r.calls.map(callText).join(" ") || "-", 44)} ${why}`);
    for (const t of r.turns) console.log(`${" ".repeat(32)}> ${t.say}\n${" ".repeat(32)}< ${(t.refusal ? `[${t.status}] ${t.refusal}` : t.reply).replace(/\n/g, " / ")}${t.pending.length ? ` [waiting on a tap: ${t.pending.map((p) => p.tool).join(", ")}]` : ""}${t.help ? ` [help card: ${t.help}]` : ""}`);
  }
}

async function main() {
  const opt = args();
  loadEnv();
  const picked = opt.only ? SCENARIOS.filter((s) => opt.only!.includes(s.id)) : SCENARIOS;
  if (!picked.length) throw new Error(`No scenario matches --only. Ids: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  const { price, source } = await modelPrice(opt.model);
  console.log(`${opt.model}: ${picked.length} scenario(s) × ${opt.runs}; price from ${source}; providers ${price.providers.join(", ")}\n`);

  const jobs = picked.flatMap((s) => Array.from({ length: opt.runs }, (_, i) => ({ s, run: i + 1 })));
  const out: Outcome[] = [];
  let stop: string | null = null;
  const worker = async () => {
    for (let job = jobs.shift(); job && !stop; job = jobs.shift()) {
      try {
        const r = await score(job.s, job.run, opt.model, price);
        out.push(r);
        const auth = r.turns.flatMap((t) => [...t.reported, ...(t.status === 401 || t.status === 403 ? [String(t.status)] : [])]).find((e) => /\b(401|403)\b/.test(e));
        if (auth && !opt.keepGoing) stop = `the Gateway refused the model (${auth}); stopped. --keep-going runs the rest anyway.`;
      } catch (e) {
        const err = e as Error;
        out.push({ id: job.s.id, run: job.run, pass: false, failed: [], latencyMs: 0, steps: 0, tokens: sum([]), costMicro: BigInt(0), calls: [], turns: [], crashed: `${err.name}: ${err.message}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opt.concurrency, jobs.length) }, worker));
  out.sort((a, b) => picked.findIndex((s) => s.id === a.id) - picked.findIndex((s) => s.id === b.id) || a.run - b.run);

  table(out);
  const passed = out.filter((r) => r.pass).length;
  const cost = out.reduce((n, r) => n + r.costMicro, BigInt(0));
  const ms = out.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log(`\n${passed}/${out.length} passed · cost ${dollars(cost)} (${cost} micro-dollars) · latency median ${ms[Math.floor(ms.length / 2)] ?? 0} ms, max ${ms[ms.length - 1] ?? 0} ms`);
  if (stop) console.log(stop);

  mkdirSync(opt.outDir, { recursive: true });
  const file = join(opt.outDir, `chat-eval-${opt.model.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
  const json = { model: opt.model, priceSource: source, providers: price.providers, ranAt: new Date().toISOString(), runs: opt.runs, summary: { passed, total: out.length, costMicro: cost, cost: dollars(cost), stopped: stop }, results: out };
  writeFileSync(file, JSON.stringify(json, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`Wrote ${file}`);
  process.exitCode = passed === out.length ? 0 : 1;
}

main().catch((e: Error) => {
  console.error(`chat-eval: ${e.message}`);
  process.exitCode = 2;
});
