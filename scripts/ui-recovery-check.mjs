import { spawnSync } from "node:child_process";

const browser = process.env.MAPLE_UI_BROWSER || process.env.REVIEW_BROWSER || "chromium";
let failed = 0;
const server = spawnSync("pnpm", ["exec", "tsx", "scripts/care-recovery-ui/server.check.ts"], { stdio: "inherit", env: process.env });
if (server.status !== 0) failed++;
for (const area of ["onboarding", "logging", "care", "notification"]) {
  const result = spawnSync(process.execPath, [`scripts/${area}-recovery-ui/run.mjs`], {
    stdio: "inherit", env: { ...process.env, MAPLE_UI_BROWSER: browser, REVIEW_BROWSER: browser },
  });
  if (result.status !== 0) failed++;
}
if (failed) process.exitCode = 1;
