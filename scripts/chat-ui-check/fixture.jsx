import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ChatTab from "../../src/components/maple/chat/ChatTab";
import { FixtureContext } from "./mocks";

const NOW = "2026-10-28T16:00:00.000Z";
const TZ = "America/New_York";
const BABY = { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: TZ, born_at: "2026-10-01T12:00:00.000Z", birth_weight_g: 3400, settings: {} };
const ENTRY = { id: 901, kind: "feed", started_at: "2026-10-28T14:10:00.000Z", ended_at: "2026-10-28T14:18:00.000Z", active: false, data: { method: "breast", left_min: 8, first_side: "L", last_side: "L" }, note: null, source: "chat", created_by: "alex@example.test", updated_by: null, created_at: NOW, updated_at: NOW };
const question = { question: "Was this the same feeding?", options: [{ id: "same", label: "Same feeding" }, { id: "separate", label: "A separate feeding" }] };
const user = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (id, parts) => ({ id, role: "assistant", parts });
const tool = (name, output, id = "call_result") => ({ type: `tool-${name}`, toolCallId: id, input: {}, state: "output-available", output });

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
  const base = { ready: true, threadId: "synthetic-thread", earlier: [], more: false, loadingEarlier: false, loadingHistory: false, historyProblem: null, recovering: false, recoveryPaused: false, status: "ready", busy: false, problem: null, help: false, messages: [] };
  if (name === "loading") return { ...base, ready: false, loadingHistory: true, busy: true };
  if (name === "history-error") return { ...base, ready: false, historyProblem: "Couldn’t load your conversation." };
  if (name === "hidden-work") return { ...base, busy: true, status: "streaming", messages: [user("msg_user", "How did the night go?"), assistant("msg_work", [{ type: "reasoning", text: "Hidden synthetic model work", state: "streaming" }])] };
  if (name === "read-work") return { ...base, busy: true, status: "streaming", messages: [user("msg_user", "How did the night go?"), assistant("msg_work", [{ type: "tool-daily_summary", toolCallId: "call_summary", state: "input-available", input: { days: 7 } }])] };
  if (name === "recovering") return { ...base, busy: true, recovering: true, messages: [user("msg_user", "How did the night go?")] };
  if (name === "question") return { ...base, messages: [user("msg_user", "Log that feeding."), assistant("msg_question", [{ type: "tool-ask_user", toolCallId: "call_question", state: "input-available", input: question }])] };
  if (name === "receipt") return { ...base, messages: [user("msg_user", "Log an 8 minute feeding on the left at 10:10."), assistant("msg_receipt", [tool("log_feed", { ok: true, write: true, text: "Saved #901: breastfeed, left 8 minutes at 10:10 AM today.", saved: [{ id: 901, line: "Saved #901: breastfeed, left 8 minutes at 10:10 AM today." }] })])] };
  if (name === "restore") return { ...base, messages: [user("msg_user", "Remove that feeding."), assistant("msg_restore", [tool("delete_entry", { ok: true, write: true, text: "Deleted #901: feeding at 10:10 AM today.", deleted: 901 })])] };
  if (name === "activity" || name === "growth") return { ...base, messages: [user("msg_user", name === "activity" ? "Show the last two weeks." : "Show her weight trend."), assistant("msg_chart", [tool("show_chart", { ok: true, write: false, text: "Here is the chart.", chart: name === "activity" ? activity : growth })])] };
  if (name === "long") return { ...base, messages: Array.from({ length: 30 }, (_, i) => i % 2 ? assistant(`msg_${i}`, [{ type: "text", text: `Synthetic reply ${i}. The log shows a completed entry at the recorded time. This example is long enough to exercise reading and scrolling.` }]) : user(`msg_${i}`, `Synthetic question ${i}: What happened in this example?`)) };
  return base;
}

function App() {
  const [state, setState] = useState(() => scenario("loading"));
  const [active, setActive] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState([ENTRY]);
  const latest = useRef({ state, draft });
  const calls = useRef([]);
  const pending = useRef(null);
  latest.current = { state, draft };
  const deferred = (kind, payload, apply) => {
    calls.current.push({ kind, ...payload });
    return new Promise((resolve) => { pending.current = (success) => { pending.current = null; if (success) apply?.(); resolve(success); }; });
  };
  const send = (text) => {
    calls.current.push({ kind: "send", text });
    setDraft("");
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
  };
  const maple = {
    state: { baby: BABY, family: { id: 99, care_name: "Sam", ask: "an owner" }, entries, me: { email: "alex@example.test", role: "owner" }, members: [], care: null },
    units: "us", now: () => new Date(NOW), readOnly: false, online: true, refresh: async () => {},
    remove: (id) => deferred("remove", { id }, () => setEntries((es) => es.filter((e) => e.id !== id))),
    restore: async (id) => (await deferred("restore", { id }, () => setEntries([ENTRY]))) ? ENTRY : null,
    toast: () => {}, memberLabel: () => "Alex", memberName: () => "Alex", toasts: [], dismissToast: () => {},
  };
  const nav = { openHelp: () => calls.current.push({ kind: "help" }), openCare: () => {}, openSupport: () => {}, openDoctor: () => {} };
  const sheets = { open: (value) => calls.current.push({ kind: "edit", value }), close: () => {}, current: null };
  const appNav = { go: (value) => calls.current.push({ kind: "navigate", value }) };
  const chatNav = useRef({ consent: { terms: true, care: false, self: false }, loadConsent: () => {}, saveConsent: async () => true, termsNeeded: () => {} }).current;

  useEffect(() => {
    window.__chatFixture = {
      scenario: (name) => { setState(scenario(name)); setEntries(name === "restore" ? [] : [ENTRY]); setDraft(""); setActive(true); setEpoch((e) => e + 1); calls.current = []; pending.current = null; },
      snapshot: () => ({ ...latest.current, calls: calls.current, pending: !!pending.current }),
      resolveAction: (success) => pending.current?.(success),
      setActive,
      appendReply: () => setState((s) => ({ ...s, messages: [...s.messages, assistant(`msg_added_${s.messages.length}`, [{ type: "text", text: "A new synthetic reply arrived below." }])] })),
    };
  }, []);

  return <FixtureContext.Provider value={{ maple, thread, nav, sheets, appNav, chatNav }}><ChatTab key={epoch} active={active} /></FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
