import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ChatTab from "../../src/components/maple/chat/ChatTab";
import { FixtureContext } from "./mocks";

const NOW = "2026-10-28T16:00:00.000Z";
const TZ = "America/New_York";
const BABY = { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: TZ, born_at: "2026-10-01T12:00:00.000Z", birth_weight_g: 3400, settings: {} };
const ENTRY = { id: 901, kind: "feed", started_at: "2026-10-28T14:10:00.000Z", ended_at: "2026-10-28T14:18:00.000Z", active: false, data: { method: "breast", left_sec: 480, first_side: "L", last_side: "L" }, note: null, source: "chat", created_by: "alex@example.test", updated_by: null, created_at: NOW, updated_at: NOW };
// Matching numeric IDs deliberately exercise the separate baby/care domains.
const CARE = { id: 901, kind: "dose", med_id: null, at: "2026-10-28T14:00:00.000Z", data: { name: "Example medicine", dose: "Example recorded amount" }, note: null, private: false, source: "chat", created_by: "alex@example.test", updated_by: null, created_at: NOW, updated_at: NOW };
const FOOD = { ...CARE, kind: "food", at: "2026-10-01T14:00:00.000Z", data: { description: "Toast and eggs", meal: "meal" }, note: "Synthetic note retained" };
const DRINK = { ...CARE, kind: "drink", at: "2026-10-01T14:00:00.000Z", data: { name: "Water", amount_ml: 237 }, note: "Synthetic note retained" };
const QUEUE_DRAFT = "A longer synthetic draft stays editable while earlier messages wait.\nThis next sentence supplies extra detail without sending it yet.\nAnother line makes the composer grow to its capped height.\nThe final line remains readable while the queue scrolls above it.";
const question = { question: "Was this the same feeding?", options: [{ id: "same", label: "Same feeding" }, { id: "separate", label: "A separate feeding" }] };
const user = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (id, parts) => ({ id, role: "assistant", parts });
const tool = (name, output, id = "call_result") => ({ type: `tool-${name}`, toolCallId: id, input: {}, state: "output-available", output });
const asking = (name, input, id) => ({ type: `tool-${name}`, toolCallId: `call_${id}`, state: "approval-requested", input, approval: { id: `approval_${id}` } });
const MEMBERS = [
  { email: "alex@example.test", role: "owner", display_name: "Alex", emoji: null, color: null },
  { email: "blake@example.test", role: "member", display_name: "Blake", emoji: null, color: null, care: "none" },
];
const INVITE_URL = "https://maple-chat-ui.example.test/signup#join=syntheticInviteToken0123456789";

const activity = {
  version: 1, kind: "activity", asOf: NOW, timezone: TZ, from: "2026-10-15", to: "2026-10-28", range: 7, metric: "feeds",
  days: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${15 + i}`, partial: i === 13, feeds: i === 4 ? null : 5 + i % 4, sleepHours: i === 4 ? null : 8 + i / 4, wet: i === 4 ? null : 4 + i % 3, dirty: i === 4 ? null : 1 + i % 2 })),
};
const growth = {
  version: 1, kind: "growth", asOf: NOW, timezone: TZ, from: "2026-10-01", to: "2026-10-28", birthWeightG: 3400, truncated: false,
  points: [
    { at: BABY.born_at, weightG: 3400, birth: true, percentile: 58, percentileLabel: "58th", implausible: false },
    { at: "2026-10-10T14:00:00.000Z", weightG: 3550, birth: false, percentile: 51, percentileLabel: "51st", implausible: false },
    { at: "2026-10-20T14:00:00.000Z", weightG: 3900, birth: false, percentile: 52, percentileLabel: "52nd", implausible: false },
    { at: "2026-10-28T14:00:00.000Z", weightG: 4250, birth: false, percentile: 55, percentileLabel: "55th", implausible: false },
  ],
};

function scenario(name) {
  const base = { ready: true, threadId: "synthetic-thread", earlier: [], more: false, loadingEarlier: false, loadingHistory: false, historyProblem: null, recovering: false, recoveryPaused: false, status: "ready", busy: false, problem: null, help: false, messages: [], queue: [], queuePaused: false, queueLimit: 10, storageProblem: false, awaitingAnswer: false };
  if (name === "loading") return { ...base, ready: false, loadingHistory: true, busy: true };
  if (name === "history-error") return { ...base, ready: false, historyProblem: "Couldn’t load your conversation." };
  if (name === "hidden-work") return { ...base, busy: true, status: "streaming", messages: [user("msg_user", "How did the night go?"), assistant("msg_work", [{ type: "reasoning", text: "Hidden synthetic model work", state: "streaming" }])] };
  if (name === "read-work") return { ...base, busy: true, status: "streaming", messages: [user("msg_user", "How did the night go?"), assistant("msg_work", [{ type: "tool-daily_summary", toolCallId: "call_summary", state: "input-available", input: { days: 7 } }])] };
  if (name === "recovering") return { ...base, busy: true, recovering: true, messages: [user("msg_user", "How did the night go?")] };
  if (name === "queue-panel") return { ...base, busy: true, status: "streaming", queuePaused: true,
    messages: [user("msg_user", "Show a synthetic daily summary."), assistant("msg_work", [{ type: "text", text: "The example log is being checked." }])],
    queue: Array.from({ length: 3 }, (_, i) => ({ requestId: `synthetic-queued-${i}`, submittedAt: NOW, state: "queued", text: `Synthetic queued message ${i + 1}: please keep this recorded detail and the longer explanation together while the earlier answer finishes. Each queued message can be reviewed before it is sent.` })),
  };
  if (name === "question") return { ...base, messages: [user("msg_user", "Log that feeding."), assistant("msg_question", [{ type: "tool-ask_user", toolCallId: "call_question", state: "input-available", input: question }])] };
  if (name === "question-error") return { ...base, messages: [assistant("msg_question", [{ type: "tool-ask_user", toolCallId: "call_question", state: "output-error", input: question, errorText: "Synthetic validation diagnostic" }])] };
  if (name === "question-malformed") return { ...base, messages: [assistant("msg_question", [{ type: "tool-ask_user", toolCallId: "call_question", state: "input-available", input: {} }])] };
  if (name === "tool-error") return { ...base, messages: [assistant("msg_error", [tool("log_feed", { ok: false, write: true, text: "Those arguments don't fit log_feed. Call maple_status.", error: { kind: "validation" } })])] };
  if (name === "receipt") return { ...base, messages: [user("msg_user", "Log an 8 minute feeding on the left at 10:10."), assistant("msg_receipt", [tool("log_feed", { ok: true, write: true, text: "Saved #901: breastfeed, left 8 minutes at 10:10 AM today.", saved: [{ id: 901, line: "Saved #901: breastfeed, left 8 minutes at 10:10 AM today." }] })])] };
  if (name === "restore") return { ...base, messages: [user("msg_user", "Remove that feeding."), assistant("msg_restore", [tool("delete_entry", { ok: true, write: true, text: "Deleted #901: feeding at 10:10 AM today.", deleted: 901 })])] };
  if (name === "care-receipt") return { ...base, messages: [user("msg_user", "I took the example medicine at ten."), assistant("msg_care", [tool("log_mom_dose", { ok: true, write: true, text: "Saved c901: Example medicine at 10:00 AM.", careReceipts: [{ id: 901, action: "saved", line: "Saved c901: Example medicine at 10:00 AM." }] })])] };
  if (name === "care-food" || name === "care-drink") {
    const food = name === "care-food";
    const line = food ? "Saved c901: Toast and eggs for Sam." : "Saved c901: Water, 237 mL for Sam.";
    return { ...base, messages: [user("msg_user", food ? "I ate toast and eggs." : "I had some water."), assistant("msg_care", [tool(food ? "log_mom_food" : "log_mom_drink", { ok: true, write: true, text: line, careReceipts: [{ id: 901, action: "saved", line }] })])] };
  }
  if (name === "activity" || name === "growth") return { ...base, messages: [user("msg_user", name === "activity" ? "Show the last two weeks." : "Show her weight trend."), assistant("msg_chart", [tool("show_chart", { ok: true, write: false, text: "Here is the chart.", chart: name === "activity" ? activity : growth })])] };
  if (name === "people-invite") return { ...base, messages: [user("msg_user", "Invite aunt@example.test so she can log, but not see Sam's page."), assistant("msg_people", [asking("invite_person", { email: "aunt@example.test", access: "log", mom_page: "none", name: "Aunt Example" }, "invite")])] };
  if (name === "people-change") return { ...base, messages: [user("msg_user", "Let Blake see Sam's page, read only."), assistant("msg_people", [asking("change_access", { person: "Blake", mom_page: "view" }, "change")])] };
  if (name === "people-owner") return { ...base, messages: [user("msg_user", "Make Blake an admin."), assistant("msg_people", [asking("change_access", { person: "Blake", access: "owner" }, "owner")])] };
  if (name === "people-remove") return { ...base, messages: [user("msg_user", "Remove Blake."), assistant("msg_people", [asking("remove_person", { person: "Blake" }, "remove")])] };
  if (name === "people-invited") return { ...base, messages: [user("msg_user", "Invite aunt@example.test to view the log."), assistant("msg_people", [tool("invite_person", { ok: true, write: true, text: "Invited aunt@example.test: sees River's log and moments, no changes. Email isn't set up, so copy the invite link from the card and send it to them.", invite: { email: "aunt@example.test", url: INVITE_URL, emailed: false } })])] };
  if (name === "long") return { ...base, messages: Array.from({ length: 30 }, (_, i) => i % 2 ? assistant(`msg_${i}`, [{ type: "text", text: `Synthetic reply ${i}. The log shows a completed entry at the recorded time. This example is long enough to exercise reading and scrolling.` }]) : user(`msg_${i}`, `Synthetic question ${i}: What happened in this example?`)) };
  return base;
}

function App() {
  const [state, setState] = useState(() => scenario("loading"));
  const [active, setActive] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState([ENTRY]);
  const [rev, setRev] = useState(0);
  const [careEnabled, setCareEnabled] = useState(false);
  const [units, setUnits] = useState("us");
  const records = useRef({ baby: { entry: structuredClone(ENTRY), deleted: false, available: true }, care: { entry: structuredClone(CARE), deleted: false, available: true } });
  const latest = useRef({ state, draft });
  const calls = useRef([]);
  const pending = useRef(null);
  latest.current = { state, draft };
  const deferred = (kind, payload, apply) => {
    calls.current.push({ kind, ...payload });
    return new Promise((resolve) => { pending.current = (success) => { pending.current = null; if (success) apply?.(); resolve(success); }; });
  };
  const send = (text, opts) => {
    calls.current.push({ kind: "send", text });
    if (opts?.clearDraft) setDraft("");
    setState((s) => ({ ...s, messages: [...s.messages, user(`msg_new_${s.messages.length}`, text)] }));
  };
  const answerQuestion = (toolCallId, answer) => deferred("answer", { toolCallId, answer }, () => {
    const label = "choiceId" in answer ? question.options.find((o) => o.id === answer.choiceId)?.label : answer.text;
    setState((s) => ({ ...s, messages: s.messages.map((m) => ({ ...m, parts: m.parts.map((p) => p.toolCallId === toolCallId ? { ...p, state: "output-available", output: { status: "answered", answer: label, ...("choiceId" in answer ? { choiceId: answer.choiceId } : {}) } } : p) })) }));
  });
  const thread = {
    ...state, draft, setDraft, send, answerQuestion,
    clearProblem: () => setState((s) => ({ ...s, problem: null })),
    approve: (id, approved) => calls.current.push({ kind: "approve", id, approved }),
    retryHistory: () => { calls.current.push({ kind: "retry-history" }); setState(scenario("loading")); },
    loadEarlier: async () => {}, remove: async () => {},
    resumeQueue: () => {}, pauseQueue: () => {}, editQueued: () => {}, discardQueued: () => {}, retryQueued: () => {},
  };
  const updateRecord = useCallback((target, patch) => {
    records.current[target] = { ...records.current[target], ...patch };
    const baby = records.current.baby;
    setEntries(baby.deleted || !baby.available ? [] : [baby.entry]);
    setRev((n) => n + 1);
  }, []);
  const api = useCallback(async (url) => {
    const parsed = new URL(url, "https://maple-chat-ui.example.test");
    if (parsed.pathname !== "/api/maple/chat/entry") throw new Error("Unexpected fixture API");
    const target = parsed.searchParams.get("target");
    const record = records.current[target];
    calls.current.push({ kind: "entry-lookup", target, id: Number(parsed.searchParams.get("id")) });
    if (!record?.available || record.entry.id !== Number(parsed.searchParams.get("id"))) throw new Error("Unavailable synthetic entry");
    return structuredClone({ entry: record.entry, deleted: record.deleted });
  }, []);
  const maple = {
    state: { baby: BABY, family: { id: 99, care_name: "Sam", ask: "an owner" }, entries, me: { email: "alex@example.test", role: "owner" }, members: MEMBERS, care: null, rev: String(rev) },
    api,
    units, setUnits, now: () => new Date(NOW), readOnly: false, online: true, refresh: async () => {},
    remove: (id) => deferred("remove", { id }, () => updateRecord("baby", { deleted: true })),
    restore: async (id) => (await deferred("restore", { id }, () => updateRecord("baby", { deleted: false }))) ? records.current.baby.entry : null,
    toast: () => {}, memberLabel: () => "Alex", memberName: (id) => MEMBERS.find((m) => m.email === id)?.display_name ?? "Alex", toasts: [], dismissToast: () => {},
  };
  const nav = { openHelp: () => calls.current.push({ kind: "help" }), openCare: () => {}, openSupport: () => {}, openDoctor: () => {} };
  const sheets = { open: (value) => calls.current.push({ kind: "edit", value }), close: () => {}, current: null };
  const appNav = { go: (value) => calls.current.push({ kind: "navigate", value }) };
  const chatNav = useRef({ consent: { terms: true, care: false, self: false }, loadConsent: () => {}, saveConsent: async () => true, termsNeeded: () => {} }).current;
  chatNav.consent.care = careEnabled;
  const care = careEnabled ? {
    access: { write: true }, name: "Sam", self: true,
    // Nutrition fixtures are deliberately older than the app's bounded state.
    state: { entries: records.current.care.deleted || ["food", "drink"].includes(records.current.care.entry.kind) ? [] : [records.current.care.entry] },
    act: {
      deleteEntry: async (id) => { if (!await deferred("care-remove", { id }, () => updateRecord("care", { deleted: true }))) throw new Error("Synthetic delete failed"); },
      restoreEntry: async (id) => { if (!await deferred("care-restore", { id }, () => updateRecord("care", { deleted: false }))) throw new Error("Synthetic restore failed"); },
      editDoseTime: async (entry, at) => { calls.current.push({ kind: "care-edit", id: entry.id, at, expected: entry.updated_at }); updateRecord("care", { entry: { ...entry, at, updated_at: "2026-10-28T16:01:00.000Z" } }); return records.current.care.entry; },
      editEntry: async (id, patch, expected) => { const old = records.current.care.entry; if (expected !== old.updated_at) throw new Error("Synthetic version conflict"); calls.current.push({ kind: "care-edit-entry", id, patch, expected }); updateRecord("care", { entry: { ...old, ...patch, data: { ...old.data, ...patch.data }, updated_at: new Date(Date.parse(old.updated_at) + 60_000).toISOString() } }); },
    },
  } : null;

  useEffect(() => {
    window.__chatFixture = {
      scenario: (name) => { records.current = { baby: { entry: structuredClone(ENTRY), deleted: name === "restore", available: true }, care: { entry: structuredClone(name === "care-food" ? FOOD : name === "care-drink" ? DRINK : CARE), deleted: false, available: true } }; setState(scenario(name)); setEntries(name === "restore" ? [] : [ENTRY]); setCareEnabled(name.startsWith("care-") || name.startsWith("people-")); setUnits("us"); setRev((n) => n + 1); setDraft(name === "queue-panel" ? QUEUE_DRAFT : ""); setActive(true); setEpoch((e) => e + 1); calls.current = []; pending.current = null; },
      snapshot: () => ({ ...latest.current, calls: calls.current, pending: !!pending.current, records: records.current }),
      resolveAction: (success) => pending.current?.(success),
      remount: () => setEpoch((n) => n + 1),
      updateRecord,
      setCareEnabled,
      setUnits,
      setActive,
      appendReply: () => setState((s) => ({ ...s, messages: [...s.messages, assistant(`msg_added_${s.messages.length}`, [{ type: "text", text: "A new synthetic reply arrived below." }])] })),
    };
  }, []);

  return <FixtureContext.Provider value={{ maple, thread, nav, sheets, appNav, chatNav, care }}><ChatTab key={epoch} active={active} /></FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
