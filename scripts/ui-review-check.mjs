import { spawnSync } from "node:child_process";

const tasks = [
  ["pnpm", ["exec", "tsx", "scripts/maple-volume-check.ts"]],
  [process.execPath, ["scripts/maple-pump-summary-check.mjs"]],
  ["pnpm", ["exec", "tsx", "scripts/ui-review-settings-birth-check.ts"]],
  ["pnpm", ["exec", "tsx", "scripts/ui-review-birth-copy-check.ts"]],
  ["pnpm", ["exec", "tsx", "scripts/ui-review-moments-api-check.ts"]],
  [process.execPath, ["scripts/ui-review-onboarding-waiting-check.mjs"]],
  [process.execPath, ["scripts/ui-review-chat-navigation-check.mjs"]],
  [process.execPath, ["scripts/ui-review-checkin-check.mjs"]],
  [process.execPath, ["scripts/first-use-ui/run.mjs"]],
  [process.execPath, ["scripts/lantern-ui-check/run.mjs"]],
  ...["scripts/ui-review-shared-check.mjs", "scripts/ui-check/logging-run.mjs", "scripts/ui-review-moments-check.mjs", "scripts/ui-review-care-check.mjs"].map((file) => [process.execPath, [file]]),
  ...["settings", "birth", "guest", "onboarding", "draft", "signout-error"].map((scenario) => [process.execPath, ["scripts/ui-review-settings-check.mjs"], { MAPLE_SETTINGS_SCENARIO: scenario }]),
];

let failed = 0;
for (const [command, args, env] of tasks) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) failed++;
}
if (failed) process.exitCode = 1;
