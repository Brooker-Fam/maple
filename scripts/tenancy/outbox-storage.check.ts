import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ApiError } from "../../src/lib/maple/client-request";
import { stampOutbox } from "../../src/lib/maple/client-state";
import { done, eq, ok, test } from "./harness";

const sources = Object.fromEntries(["useMaple", "care/useCare"].map((name) => [name, ts.createSourceFile(`${name}.tsx`, readFileSync(`src/components/maple/${name}.tsx`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]));

function sourceFunction<T>(file: string, name: string, context: Record<string, unknown> = {}): T {
  const source = sources[file];
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`Missing ${file} function ${name}`);
  const js = ts.transpileModule(`(${found.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return runInNewContext(js, { Error, ...context }) as T;
}

type Item = {
  target: "mood" | "care" | "entries";
  client_id: string;
  family: number;
  member: string;
  input: { data: Record<string, unknown>; note?: string | null; kind?: string; client_id?: string };
  entry: { id: number; note?: string | null };
  id?: number;
  tries: number;
};

const storageError = "Couldn't save on this phone. Keep this page open and try again.";

function queueFixture(...items: Item[]) {
  const outboxRef = { current: items };
  const stateRef = { current: { family: { id: 99 }, me: { email: "sam@example.test" }, entries: items.map((item) => item.entry) } };
  let durable: string | null = JSON.stringify(items);
  let failNext = false;
  const localStorage = {
    setItem: (_key: string, value: string) => {
      if (failNext) { failNext = false; throw new Error("Synthetic storage failure"); }
      durable = value;
    },
    removeItem: () => {
      if (failNext) { failNext = false; throw new Error("Synthetic storage failure"); }
      durable = null;
    },
  };
  const writeOutbox = sourceFunction("useMaple", "writeOutbox", { localStorage, OUTBOX_KEY: "maple-outbox-v1" });
  const setQueue = sourceFunction<(items: Item[]) => void>("useMaple", "setQueue", { outboxRef, stateRef, stampOutbox, writeOutbox, setOutbox: () => {} });
  return { outboxRef, stateRef, setQueue, durable: () => durable, failNext: () => { failNext = true; } };
}

const pendingMood = (): Item => ({ target: "mood", client_id: "synthetic-check-in", family: 99, member: "sam@example.test", input: { data: { mood: "steady" }, note: null }, entry: { id: -1, note: null }, tries: 1 });

function uploadingFixture(items: Item[], holdAt = 1) {
  const f = queueFixture(...items);
  const flushingEntry = { current: null as number | null };
  const requests: { path: string; init: RequestInit }[] = [];
  const saved: Record<string, unknown>[] = [];
  const toasts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const context = {
    ...f, flushingEntry, flushing: { current: false }, syncedEntryIds: { current: { ids: new Map() } },
    ownedBy: sourceFunction("useMaple", "ownedBy"),
    isEntryItem: sourceFunction("useMaple", "isEntryItem"), isMoodItem: sourceFunction("useMaple", "isMoodItem"), isCareItem: sourceFunction("useMaple", "isCareItem"),
    OUTBOX_URL: { entries: "/api/maple/entries", care: "/api/maple/care/entries", mood: "/api/maple/care/mood" },
    fetchJson: async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      if (init.method === "DELETE") throw new Error("Synthetic deletion outage");
      const body = JSON.parse(String(init.body));
      saved.push(body);
      if (requests.length === holdAt) await gate;
      return { entry: { id: 700 + requests.length, ...body } };
    },
    forceRefresh: async () => {}, setOnline: () => {}, dropEntry: () => {}, upsert: () => {}, setState: () => {}, toastIcon: () => null,
    toast: (text: string) => toasts.push(text), careDuplicateToast: () => {}, isFamilyMismatch: () => false, isTransient: () => true,
    optimistic: () => () => {}, withInflight: <T,>(fn: () => Promise<T>) => fn(), discardedLine: () => null, labelFor: () => null, restore: () => {},
  };
  return {
    ...f, requests, saved, toasts, release,
    flush: sourceFunction<() => Promise<void>>("useMaple", "flush", context),
    update: sourceFunction<(id: number, patch: { note: string }) => Promise<Item["entry"] | null>>("useMaple", "update", context),
    remove: sourceFunction<(id: number) => Promise<boolean>>("useMaple", "remove", context),
    unqueue: sourceFunction<(id: number) => boolean>("useMaple", "unqueue", context),
    unqueueMood: sourceFunction<(id: number) => boolean>("useMaple", "unqueueMood", context),
  };
}

const pendingBottle = (n: number): Item => ({ target: "entries", client_id: `synthetic-bottle-${n}`, family: 99, member: "sam@example.test", input: { client_id: `synthetic-bottle-${n}`, kind: "feed", data: { method: "bottle", amount_ml: 60 }, note: null }, entry: { id: -n, note: null }, tries: 1 });

async function main() {
  await test("a check-in edited during upload keeps its durable correction when follow-up storage fails", async () => {
    const item = pendingMood();
    const f = queueFixture(item);
    const toasts: string[] = [];
    const requests: { path: string; init: RequestInit }[] = [];
    const saved = new Map<string, { id: number; note: string | null }>();
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const isFamilyMismatch = sourceFunction("useMaple", "isFamilyMismatch", { ApiError });
    const flush = sourceFunction<() => Promise<void>>("useMaple", "flush", {
      ...f, flushing: { current: false }, flushingEntry: { current: null }, syncedEntryIds: { current: { ids: new Map() } },
      ownedBy: sourceFunction("useMaple", "ownedBy"),
      isEntryItem: sourceFunction("useMaple", "isEntryItem"), isMoodItem: sourceFunction("useMaple", "isMoodItem"), isCareItem: sourceFunction("useMaple", "isCareItem"),
      OUTBOX_URL: { entries: "/api/maple/entries", care: "/api/maple/care/entries", mood: "/api/maple/care/mood" },
      fetchJson: async (path: string, init: RequestInit) => {
        requests.push({ path, init });
        const body = JSON.parse(String(init.body));
        const deduped = saved.has(item.client_id);
        if (init.method === "POST") {
          if (!saved.has(item.client_id)) saved.set(item.client_id, { id: 701, note: body.note });
          if (requests.length === 1) await deferred;
        } else if (init.method === "PATCH") saved.get(item.client_id)!.note = body.note;
        return { entry: saved.get(item.client_id), deduped };
      },
      newClientId: () => "synthetic-followup", forceRefresh: async () => {}, setOnline: () => {},
      toast: (text: string) => toasts.push(text), careDuplicateToast: () => {},
      isFamilyMismatch, isTransient: sourceFunction("useMaple", "isTransient", { ApiError, isFamilyMismatch }),
    });
    const pending = flush();
    const note = "Synthetic correction typed while upload runs";
    f.setQueue([{ ...item, input: { ...item.input, note }, entry: { ...item.entry, note } }]);
    f.failNext();
    release();
    await pending;
    eq(f.outboxRef.current.length, 1, "the correction stays pending");
    eq(JSON.parse(f.durable()!)[0].input.note, note, "the correction stays durable");
    ok(toasts.includes(storageError), "the failed transition must show its storage error");
    await flush();
    await flush();
    eq(saved.size, 1, "retrying does not create another check-in");
    eq(saved.get(item.client_id)?.note, note, "the correction reaches the saved check-in");
    eq(requests.map((request) => request.init.method), ["POST", "POST", "PATCH"]);
    eq(f.outboxRef.current.length, 0);
    eq(f.durable(), null);
  });

  await test("a queued care deletion reports a storage failure and preserves the entry for retry", async () => {
    const item: Item = { ...pendingMood(), target: "care", client_id: "synthetic-question", input: { data: { question: "Synthetic question" } } };
    const f = queueFixture(item);
    const toasts: string[] = [];
    let visible = true;
    const store = { unqueue: sourceFunction<(id: number) => boolean>("useMaple", "unqueue", { ...f, flushing: { current: false }, isCareItem: sourceFunction("useMaple", "isCareItem"), setState: () => { visible = false; } }) };
    const deleteEntry = sourceFunction<(id: number) => Promise<void>>("care/useCare", "deleteEntry", {
      store, unholdEntry: () => {}, toast: (text: string) => toasts.push(text), fail: (error: Error) => error,
    });
    const before = f.durable();
    f.failNext();
    await deleteEntry(-1).catch(() => {});
    eq(f.durable(), before);
    eq(f.outboxRef.current.length, 1);
    eq(visible, true);
    eq(toasts, [storageError]);
    await deleteEntry(-1);
    eq(f.outboxRef.current.length, 0);
    eq(f.durable(), null);
    eq(visible, false);
    eq(toasts, [storageError, "Removed"]);
  });
  await test("an edit to a later queued bottle reaches the server after the first upload finishes", async () => {
    const f = uploadingFixture([pendingBottle(1), pendingBottle(2)]);
    const uploading = f.flush();
    const note = "Synthetic correction before the second bottle uploads";
    const edited = await f.update(-2, { note });
    eq(edited?.note, note);
    eq(JSON.parse(f.durable()!)[1].input.note, note);
    f.release();
    await uploading;
    eq(f.saved[1].note, note);
    eq(f.requests.length, 2);
    eq(f.requests[1].init.headers, { "X-Maple-Family": "99" });
    eq(f.outboxRef.current.length, 0);
    eq(f.durable(), null);
  });

  await test("removing a bottle during upload asks for a retry without discarding the durable entry", async () => {
    const f = uploadingFixture([pendingBottle(1)]);
    const uploading = f.flush();
    const before = f.durable();
    const removed = await f.remove(-1);
    const after = f.durable();
    f.release();
    await uploading;
    eq(removed, false);
    eq(after, before);
    eq(f.requests.map((request) => request.init.method), ["POST"]);
    eq(f.toasts, ["One sec, that's still saving"]);
    eq(f.saved.length, 1);
    eq(f.outboxRef.current.length, 0);
  });

  await test("removing a bottle already uploaded in an unfinished batch waits and then uses its saved ID", async () => {
    const f = uploadingFixture([pendingBottle(1), pendingBottle(2)], 2);
    const uploading = f.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    eq(f.requests.length, 2);
    const removed = await f.remove(-1);
    f.release();
    await uploading;
    eq(removed, false);
    eq(f.toasts, ["One sec, that's still saving"]);
    eq(await f.remove(-1), false);
    eq(f.requests[2].path, "/api/maple/entries?id=701");
    eq(f.requests[2].init.method, "DELETE");
    eq(f.toasts, ["One sec, that's still saving", "Synthetic deletion outage"]);
  });

  for (const target of ["care", "mood"] as const) {
    for (const holdAt of [1, 2]) {
      await test(`removing a queued ${target} entry during upload ${holdAt} keeps it pending and explains the retry`, async () => {
        const item = { ...pendingMood(), target };
        const f = uploadingFixture(holdAt === 1 ? [item] : [item, pendingBottle(2)], holdAt);
        const uploading = f.flush();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const before = f.durable();
        let error: unknown;
        try { (target === "care" ? f.unqueue : f.unqueueMood)(item.entry.id); } catch (e) { error = e; }
        const after = f.durable();
        f.release();
        await uploading;
        ok(error instanceof Error && error.message === "One sec, that's still saving", "deletion must reject while uploading");
        eq(after, before);
        eq(f.requests.map((request) => request.init.method), Array(holdAt).fill("POST"));
        if (target === "mood") eq(f.toasts, ["One sec, that's still saving"]);
        eq(f.outboxRef.current.length, 0);
      });
    }
  }
  done("outbox-storage");
}

void main();
