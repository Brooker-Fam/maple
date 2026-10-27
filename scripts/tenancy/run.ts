import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm check:maple-tenancy: runs every scripts/tenancy/*.check.ts in its own
 * process (each gets its own in-memory databases), or only the ones named:
 *   pnpm check:maple-tenancy schema context
 */
const dir = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".check.ts"))
  .filter((f) => !only.length || only.includes(f.replace(/\.check\.ts$/, "")))
  .sort();

if (!files.length) {
  console.error("No tenancy checks matched.");
  process.exit(1);
}

const tsx = join(dir, "..", "..", "node_modules", ".bin", "tsx");
const failedFiles: string[] = [];
for (const file of files) {
  console.log(`\n── ${file}`);
  const run = spawnSync(tsx, [join(dir, file)], { stdio: "inherit", env: { ...process.env, DATABASE_URL: "" } });
  if (run.status !== 0) failedFiles.push(file);
}

console.log(`\n${files.length - failedFiles.length} of ${files.length} tenancy check files passed${failedFiles.length ? `; failed: ${failedFiles.join(", ")}` : ""}`);
if (failedFiles.length) process.exit(1);
