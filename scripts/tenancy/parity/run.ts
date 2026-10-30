import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm check:maple-parity [ref]: family 1's answers from the code before
 * families (`ref`, default the branch's merge-base with origin/main) and from
 * this working tree, on identical made-up data (scenario.ts). The old tree is
 * exported with git archive and gets this tree's database layer (OVERLAY): it
 * runs on PGlite against the schema migrate.ts makes now, as the deployed old
 * code would for the minutes a deploy takes. Exits 1 on any difference
 * outside ADDED, the additions family 1 is allowed to see. Nothing leaves
 * the machine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const ref = process.argv[2] ?? git("merge-base", "HEAD", "origin/main");

/** What the new code may add for family 1 (`added`: only it has the path) or answer differently, each with why. Everything else must match exactly. */
const EXPECTED: { path: RegExp; added?: true; why: string }[] = [
  { path: /^out\.me\.(owner|none|stranger)\.body\.signup$/, added: true, why: "sign-in receives the signup switch" },
  { path: /^out\.me\.(owner|none|stranger)\.body\.(apple|email)$/, added: true, why: "sign-in receives the configured Apple and email options" },
  { path: /^out\..+\.body\.family$/, added: true, why: "the state names its family (id, and who a viewer asks)" },
  { path: /^out\.invites\..+\.invite\.email$/, added: true, why: "an invite says whose address it's for (none for a link)" },
  { path: /^db\.[^.]+$/, added: true, why: "a table new code made" },
  { path: /^db\.[^.]+\.\[[^\]]+\]\.[^.]+$/, added: true, why: "a column new code added" },
  { path: /^db\.maple_push_sent\.\[cleanup:[^\]]+\]$/, added: true, why: "the daily cleanup of abandoned onboarding families claims its day" },
  { path: /^db\.maple_members\.\[[^\]]+\]\.accepted_at$/, why: "new code records when someone took up a membership; old code leaves it null" },
  { path: /^out\.mcp\.(maple_status|admin)\.sc\.family_memories$/, added: true, why: "maple_status carries the family's memories (none in this scenario) for a connected app" },
  {
    path: /^out\.mcp\.(stranger|removed)\.(isError|sc|text)$/,
    why: "the scenario calls tools without the MCP route, which turned these callers away (401) before; now the tools refuse them too",
  },
];

const OVERLAY = ["src/lib/db.ts", "src/lib/migrate.ts", "src/lib/maple/family-tables.ts", "src/lib/maple/family/schema.ts", "src/lib/maple/auth-schema.ts", "src/lib/maple/memory/schema.ts"];

const FIXED_DAY = "2026-10-27";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
/** maple_status's JSON line ends with the family's memories now; with none, that exact ending reads as before. */
const NO_MEMORIES = /,"family_memories":\{"as_of":"\d{4}-\d{2}-\d{2}","memories":\[\]\}\}$/;

const work = mkdtempSync(join(tmpdir(), "maple-parity-"));
try {
  const trees = { before: join(work, "before"), now: join(work, "now") };
  mkdirSync(trees.before);
  execFileSync("sh", ["-c", `git -C "${root}" archive "${ref}" src package.json tsconfig.json | tar -x -C "${trees.before}"`]);
  for (const p of OVERLAY) cpSync(join(root, p), join(trees.before, p));
  mkdirSync(trees.now);
  for (const p of ["src", "package.json", "tsconfig.json"]) cpSync(join(root, p), join(trees.now, p), { recursive: true });

  const outs: Record<string, unknown> = {};
  for (const [name, tree] of Object.entries(trees)) {
    symlinkSync(join(root, "node_modules"), join(tree, "node_modules"));
    const dir = join(tree, "scripts", "tenancy", "parity");
    mkdirSync(dir, { recursive: true });
    cpSync(join(here, "scenario.ts"), join(dir, "scenario.ts"));
    const out = join(work, `${name}.json`);
    const run = spawnSync(join(root, "node_modules", ".bin", "tsx"), ["--import", join(here, "clock.mjs"), join(dir, "scenario.ts"), out], {
      cwd: tree,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, DATABASE_URL: "", TZ: "UTC" },
    });
    if (run.status !== 0) throw new Error(`the ${name} tree's scenario failed`);
    outs[name] = JSON.parse(readFileSync(out, "utf8"));
  }

  const lines = differences(normal(steady(outs.before)), normal(steady(outs.now)), "");
  const allowed = lines.filter((l) => EXPECTED.some((e) => e.path.test(l.path) && (!e.added || l.added)));
  const bad = lines.filter((l) => !allowed.includes(l));
  const calls = Object.keys((outs.now as { out: object }).out).length;
  for (const l of bad) console.log(`DIFF ${l.path}: ${l.text}`);
  for (const e of EXPECTED) {
    const n = allowed.filter((l) => e.path.test(l.path)).length;
    if (n) console.log(`allowed ${n}: ${e.why}`);
  }
  console.log(`\n${calls} answers against ${ref.slice(0, 7)}: ${bad.length} differences${allowed.length ? ` (${allowed.length} allowed)` : ""}`);
  if (bad.length) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

/**
 * Random values (her page's 8-digit ids, invite and receipt tokens) read as
 * the order they first appear in, so the two runs compare. Rows are keyed by
 * their own key or id, so one added row doesn't shift every row after it.
 */
function steady(run: unknown): unknown {
  const seen = new Map<string, string>();
  const mark = (v: string, kind: string) => {
    if (!seen.has(v)) seen.set(v, `<${kind} ${seen.size + 1}>`);
    return seen.get(v)!;
  };
  const SEEDED = new Set(["10000001", "10000002"]);
  const text = (s: string) => s.replace(/\b[0-9a-f]{32}\b|\b[0-9a-f]{64}\b/g, (m) => mark(m, "token")).replace(/\b([cp]?)([1-9]\d{7})\b/g, (m, pre: string, id: string) => (SEEDED.has(id) ? m : `${pre}${mark(id, "care id")}`));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (typeof v === "number" && Number.isInteger(v) && v >= 10_000_000 && v < 100_000_000) return SEEDED.has(String(v)) ? v : mark(String(v), "care id");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [text(k), walk((v as Record<string, unknown>)[k])]));
    return v;
  };
  const { out, db } = run as { out: unknown; db: Record<string, Record<string, unknown>[]> };
  const keyed = Object.fromEntries(
    Object.entries(db).map(([table, rows]) => [table, Object.fromEntries(rows.map((r, i) => [`[${String(r.key ?? r.email ?? r.id ?? i)}]`, r]))])
  );
  return walk({ out, db: keyed });
}

/**
 * family_id is ignored (every family-1 row has it now); a time from Postgres'
 * own NOW() isn't frozen, so it's masked; an empty family_memories at the end
 * of a tool's text is dropped (its key in sc is an allowed addition).
 */
function normal(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normal);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "family_id")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, normal(x)])
    );
  }
  if (typeof v === "string" && ISO.test(v)) return v.startsWith(FIXED_DAY) || v < "2026-10-27T14:00:01" ? v : "<pg-now>";
  if (typeof v === "string" && NO_MEMORIES.test(v)) return v.replace(NO_MEMORIES, "}");
  return v;
}

type Line = { path: string; text: string; added: boolean };

function differences(a: unknown, b: unknown, path: string): Line[] {
  const show = (x: unknown) => JSON.stringify(x)?.slice(0, 300);
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) return [{ path, text: `${show(a)} != ${show(b)}`, added: false }];
  if (Array.isArray(a)) {
    const out: Line[] = a.length !== (b as unknown[]).length ? [{ path, text: `${a.length} items != ${(b as unknown[]).length}`, added: false }] : [];
    a.forEach((x, i) => i < (b as unknown[]).length && out.push(...differences(x, (b as unknown[])[i], `${path}[${i}]`)));
    return out;
  }
  if (a && typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    return [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort().flatMap((k) => {
      const p = path ? `${path}.${k}` : k;
      if (!(k in ao)) return [{ path: p, text: `only now: ${show(bo[k])}`, added: true }];
      if (!(k in bo)) return [{ path: p, text: `only before: ${show(ao[k])}`, added: false }];
      return differences(ao[k], bo[k], p);
    });
  }
  return a === b ? [] : [{ path, text: `${show(a)} != ${show(b)}`, added: false }];
}
