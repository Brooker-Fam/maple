import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAPLE_ORIGIN } from "../../src/lib/maple/origin";
import { SIRI_SHORTCUTS } from "../../src/lib/maple/siri-shortcuts";
import { shortcutTemplate } from "./template";

if (process.platform !== "darwin") throw new Error("Apple shortcut signing requires macOS");
const temporary = mkdtempSync(path.join(tmpdir(), "maple-shortcuts-"));
const files: Record<string, string> = {};
try {
  for (const shortcut of SIRI_SHORTCUTS) {
    const input = path.join(temporary, shortcut.file);
    const output = path.resolve("public/shortcuts", shortcut.file);
    execFileSync("/usr/bin/plutil", ["-convert", "binary1", "-o", input, "-"], {
      input: JSON.stringify(shortcutTemplate(shortcut.name, shortcut.action, MAPLE_ORIGIN)),
    });
    execFileSync("/usr/bin/shortcuts", ["sign", "--mode", "anyone", "--input", input, "--output", output], { stdio: "pipe" });
    files[shortcut.file] = createHash("sha256").update(readFileSync(output)).digest("hex");
    console.log(`Signed ${shortcut.name}`);
  }
  writeFileSync("public/shortcuts/catalog.json", JSON.stringify({ origin: MAPLE_ORIGIN, files }, null, 2) + "\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
