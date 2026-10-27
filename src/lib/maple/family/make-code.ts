import { pathToFileURL } from "node:url";
import { createSignupCode } from "./codes";
import { migrateSignup } from "./schema";

/**
 * Makes one sign-up invite code and prints it once. Run by the owner, against
 * the database they mean to (DATABASE_URL), never by a build:
 *   DATABASE_URL=… pnpm tsx src/lib/maple/family/make-code.ts "for the Example family" [uses] [days]
 */
async function main() {
  const [label, uses, days] = process.argv.slice(2);
  await migrateSignup();
  console.log(await createSignupCode({ label: label ?? null, maxUses: uses ? Number(uses) : 1, days: days ? Number(days) : null }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("Couldn't make a code:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
