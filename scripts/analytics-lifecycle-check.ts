import assert from "node:assert/strict";
import { appOpenTracker } from "../src/components/maple/analytics-lifecycle";

async function main() {
  const requests: { family: number; id: string }[] = [];
  let allowed = false;
  let sequence = 0;
  const tracker = appOpenTracker(async (family, id) => {
    requests.push({ family, id });
    return allowed;
  }, () => `synthetic-${++sequence}`);
  assert.equal(await tracker.open(901, "parent-a@example.test"), false);
  allowed = true;
  assert.equal(await tracker.open(901, "parent-a@example.test"), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, requests[1].id);
  await tracker.open(901, "parent-a@example.test");
  assert.equal(requests.length, 2);
  await tracker.open(901, "parent-a@example.test", true);
  assert.equal(requests.length, 3);
  assert.notEqual(requests[1].id, requests[2].id);
  await tracker.open(901, "parent-b@example.test");
  await tracker.open(902, "parent-a@example.test");
  assert.equal(requests.length, 5);
  assert.equal(new Set(requests.map((request) => request.id)).size, 4);

  let release: (value: boolean) => void = () => {};
  let calls = 0;
  const slow = appOpenTracker(() => {
    calls++;
    return new Promise<boolean>((resolve) => { release = resolve; });
  }, () => "synthetic-flight");
  const first = slow.open(901, "parent-a@example.test");
  const second = slow.open(901, "parent-a@example.test");
  assert.equal(calls, 1);
  release(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  console.log("Analytics lifecycle: retries, deduplication, returns, member and family separation passed");
}

void main();
