import assert from "node:assert/strict";
import { formatVolume } from "../src/lib/maple/units";

assert.equal(formatVolume(0.01, "metric"), "<0.1 ml");
console.log("PASS positive volume below metric display precision stays distinguishable from zero");
