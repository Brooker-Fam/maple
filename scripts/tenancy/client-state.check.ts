import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { keepConfirmed, stampOutbox } from "../../src/lib/maple/client-state";
import type { Entry } from "../../src/lib/maple/types";
import type { Toast } from "../../src/components/maple/useMaple";
import { done, eq, test } from "./harness";

const entry: Entry = {
  id: 123,
  kind: "note",
  started_at: "2026-01-01T00:00:00.000Z",
  ended_at: null,
  active: false,
  data: {},
  note: "Synthetic note",
  created_by: "owner@example.test",
  updated_by: null,
  source: "web",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:01.000Z",
};

function state(family: number, email = "owner@example.test", entries: Entry[] = []) {
  return { family: { id: family }, me: { email }, entries };
}

const confirmed = () => new Map([[entry.id, { updatedAt: entry.updated_at, at: 2000 }]]);

const clientSource = ts.createSourceFile("useMaple.tsx", readFileSync("src/components/maple/useMaple.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function clientFunction<T>(name: string, context: Record<string, unknown> = {}): T {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(clientSource) === name && node.initializer) {
      found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    if (name === "staleToasts" && ts.isCallExpression(node) && node.expression.getText(clientSource) === "useEffect" && node.arguments[0]?.getText(clientSource).includes("const stale = toasts.filter")) {
      found = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(clientSource);
  if (!found) throw new Error(`Missing client function ${name}`);
  const js = ts.transpileModule(`(${found.getText(clientSource)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return runInNewContext(js, context) as T;
}

type Queued = {
  target: string;
  client_id: string;
  family?: number;
  member?: string;
  entry: { id: number };
  input: Record<string, unknown>;
  tries: number;
};

const pendingMood = (): Queued => ({ target: "mood", client_id: "synthetic-mood", family: 1, member: "owner@example.test", entry: { id: -1 }, input: { data: { mood: "steady" } }, tries: 1 });
const otherSessions = () => [state(2), state(1, "second@example.test")];

function flushing(item: Queued) {
  const outboxRef = { current: [item] };
  const stateRef = { current: state(1) };
  const requests: { path: string; init: RequestInit }[] = [];
  let resolve!: (value: unknown) => void;
  const reply = new Promise((done) => { resolve = done; });
  const flush = clientFunction<() => Promise<void>>("flush", {
    flushing: { current: false }, outboxRef, stateRef,
    ownedBy: clientFunction("ownedBy"),
    isMoodItem: clientFunction("isMoodItem"), isCareItem: clientFunction("isCareItem"),
    OUTBOX_URL: { entries: "/api/maple/entries", care: "/api/maple/care/entries", mood: "/api/maple/care/mood" },
    fetchJson: (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return requests.length === 1 ? reply : Promise.resolve({});
    },
    newClientId: () => "synthetic-followup",
    setQueue: (items: Queued[]) => { outboxRef.current = stampOutbox(items, outboxRef.current, stateRef.current); },
    forceRefresh: async () => {}, setOnline: () => {}, toast: () => {},
    isFamilyMismatch: () => false, isTransient: () => false,
  });
  return { flush, resolve, outboxRef, stateRef, requests };
}

function duplicateNotice() {
  const stateRef = { current: state(1) };
  const toasts: Toast[] = [];
  const requests: RequestInit[] = [];
  const show = clientFunction<(item: Queued, dose: unknown) => void>("careDuplicateToast", {
    stateRef, tzRef: { current: "UTC" }, ownedBy: clientFunction("ownedBy"),
    nameOf: () => "A parent", formatTime: () => "12:00 AM",
    toast: (text: string, opts: Partial<Toast> = {}) => toasts.push({ id: toasts.length + 1, text, tone: "ok", ...opts }),
    fetchJson: (_path: string, init: RequestInit) => { requests.push(init); return Promise.resolve({}); },
    forceRefreshRef: { current: async () => {} },
  });
  const item = { ...pendingMood(), target: "care", input: { client_id: "synthetic-dose", kind: "dose", data: { name: "Synthetic medicine", amount: 1, unit: "tablet" } } };
  const dose = { created_by: "owner@example.test", data: { name: "Synthetic medicine" }, at: "2026-01-01T00:00:00Z" };
  return { stateRef, toasts, requests, show: () => show(item, dose), item };
}

async function main() {
  await test("adding an entry in another family leaves legacy queued entries in family 1", () => {
    const legacy = { client_id: "synthetic-legacy", entry, tries: 1 };
    const fresh = { client_id: "synthetic-new", entry: { ...entry, id: 124 }, tries: 1 };
    const stamped = stampOutbox([{ ...legacy, tries: 2 }, fresh], [legacy], state(2, "second@example.test"));
    eq(stamped, [
      { ...legacy, tries: 2, family: 1 },
      { ...fresh, family: 2, member: "second@example.test" },
    ]);
    eq(stampOutbox(stamped, stamped, state(3)), stamped);
  });

  await test("a poll for another family never inherits confirmed entries from the previous family", () => {
    const previous = state(1, "owner@example.test", [entry]);
    const next = state(2);
    const saved = confirmed();
    eq(keepConfirmed(next, previous, saved, 1000), next);
    eq(saved.size, 0);
    eq(keepConfirmed(state(1), previous, confirmed(), 1000).entries, [entry]);
  });

  await test("a poll for another member never inherits a previous member's confirmed entry version", () => {
    const previous = state(1, "owner@example.test", [entry]);
    const older = { ...entry, note: "Synthetic earlier version", updated_at: entry.created_at };
    const next = state(1, "viewer@example.test", [older]);
    const saved = confirmed();
    eq(keepConfirmed(next, previous, saved, 1000), next);
    eq(saved.size, 0);
    eq(keepConfirmed(state(1, "owner@example.test", [older]), previous, confirmed(), 1000).entries, [entry]);
  });

  await test("a mood edit queued while its upload finishes keeps the source family and member", async () => {
    for (const owner of otherSessions()) {
      const item = pendingMood();
      const run = flushing(item);
      const pending = run.flush();
      run.outboxRef.current = [{ ...item, input: { data: { mood: "tired" }, note: "Synthetic update" } }];
      run.stateRef.current = owner;
      run.resolve({ entry: { id: 55 } });
      await pending;
      eq(run.outboxRef.current.length, 1);
      const followup = run.outboxRef.current[0];
      eq({ family: followup.family, member: followup.member }, { family: 1, member: "owner@example.test" });
      eq(followup.input, { data: { mood: "tired" }, note: "Synthetic update" });
    }
  });

  await test("an upload removed while in flight rolls back with its source family header", async () => {
    for (const item of [pendingMood(), { ...pendingMood(), family: undefined, member: undefined }]) {
      const run = flushing(item);
      const pending = run.flush();
      eq(run.requests[0].init.headers, { "X-Maple-Family": "1" });
      run.outboxRef.current = [];
      run.stateRef.current = state(2);
      run.resolve({ entry: { id: 55 } });
      await pending;
      eq(run.requests[1], { path: "/api/maple/care/mood?id=55", init: { method: "DELETE", headers: { "X-Maple-Family": "1" } } });
    }
  });

  await test("a duplicate dose response never shows another family's or member's medicine", () => {
    for (const owner of otherSessions()) {
      const notice = duplicateNotice();
      notice.stateRef.current = owner;
      notice.show();
      eq(notice.toasts.length, 0);
    }
  });

  await test("a duplicate dose action cannot send after its family or member changes", () => {
    for (const owner of otherSessions()) {
      const notice = duplicateNotice();
      notice.show();
      notice.stateRef.current = owner;
      notice.toasts[0].actions![0].onClick();
      eq(notice.requests.length, 0);
    }
    const notice = duplicateNotice();
    notice.show();
    notice.toasts[0].actions![0].onClick();
    eq(notice.requests, [{ method: "POST", headers: { "X-Maple-Family": "1" }, body: JSON.stringify({ ...notice.item.input, allow_duplicate: true }) }]);
  });

  await test("a visible duplicate dose notice disappears after its family or member changes", () => {
    for (const owner of otherSessions()) {
      const notice = duplicateNotice();
      notice.show();
      let remaining = notice.toasts;
      clientFunction<() => void>("staleToasts", {
        state: owner, toasts: notice.toasts, ownedBy: clientFunction("ownedBy"),
        setToasts: (change: (items: Toast[]) => Toast[]) => { remaining = change(remaining); },
      })();
      eq(remaining.length, 0);
    }
  });

  done("client-state.check.ts");
}

void main();
