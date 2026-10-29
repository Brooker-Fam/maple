import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppNavProvider, useAppNav } from "../../src/components/maple/AppNav";
import NutritionSection from "../../src/components/maple/care/NutritionSection";
import { ChatNavProvider } from "../../src/components/maple/chat/ChatNav";
import ChatTab from "../../src/components/maple/chat/ChatTab";
import { FixtureContext } from "./mocks";

const NOW = new Date("2026-10-28T02:30:00.000Z");
const MEMBER = { email: "sam@example.test", display_name: "Sam Example", role: "owner" };
const initialState = (self) => ({
  family: { id: 99, care_name: "Sam Example", ask: "an owner" },
  baby: { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", settings: {} },
  me: { ...MEMBER, email: self ? MEMBER.email : "alex@example.test" }, members: [MEMBER], entries: [],
  care: {
    person: { member: MEMBER.email, name: MEMBER.display_name, self, created_by: MEMBER.email },
    access: { self, read: true, write: true, private: self, mood: false, therapist: false, manage: true },
    settings: { checkin_suggestions: false, feeding: "no" }, plans: [], entries: [],
  },
});

function Contents({ care }) {
  const nav = useAppNav();
  const [visitedChat, setVisitedChat] = useState(false);
  useEffect(() => {
    if (nav.tab === "chat") setVisitedChat(true);
  }, [nav.tab]);
  return <>
    <main hidden={nav.tab === "chat"} className="mx-auto min-h-screen max-w-lg bg-mp-bg p-5 pb-20">
      <h1 className="mb-6 text-3xl text-mp-ink">{care.name}</h1>
      <NutritionSection key={`${care.state.person.member}:${care.name}`} care={care} />
    </main>
    {(visitedChat || nav.tab === "chat") && <ChatTab active={nav.tab === "chat"} />}
    <nav aria-label="Fixture tabs" className="fixed inset-x-0 bottom-0 z-[70] flex h-[57px] justify-around bg-mp-surface text-mp-ink">
      <button type="button" onClick={() => nav.go("care")}>Care tab</button>
      <button type="button" onClick={() => nav.go("chat")}>Chat tab</button>
    </nav>
  </>;
}

function App() {
  const options = new URLSearchParams(window.location.search);
  const [state, setState] = useState(() => initialState(options.get("self") !== "false"));
  const [draft, setDraft] = useState(options.get("draft") ?? "");
  const calls = useRef([]);
  const latest = useRef({ state, draft });
  latest.current = { state, draft };
  const consents = useRef({ terms: options.get("terms") !== "false", care: options.get("care") !== "false", self: options.get("self") !== "false" });
  const api = useCallback(async (pathname, init = {}) => {
    const url = new URL(pathname, "https://maple-nutrition-chat.example.test");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.current.push({ kind: "api", path: url.pathname, query: url.search, method, body });
    if (url.pathname === "/api/maple/chat/consent") {
      if (method === "POST") consents.current = { ...consents.current, ...body };
      return { ...consents.current };
    }
    if (url.pathname === "/api/maple/care/entries" && method === "GET") return { entries: [], tz: "America/New_York" };
    if (url.pathname === "/api/maple/care/entries" && method === "POST") return {
      created: true, notes: [], entry: {
        ...body, id: 900 + calls.current.length, med_id: null, note: body.note ?? null, private: false,
        created_by: MEMBER.email, updated_by: null, source: "web", created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      },
    };
    throw new Error(`Unexpected synthetic API: ${method} ${url.pathname}`);
  }, []);
  const store = useMemo(() => ({
    patch: (update) => setState((current) => ({ ...current, care: update(current.care) })),
    track: (fn) => fn(), tempId: () => -1,
    queue: () => { throw new Error("Unexpected offline write"); },
  }), []);
  const care = {
    state: state.care, self: state.care.access.self, access: state.care.access, name: state.care.person.name,
    act: { editEntry: () => { throw new Error("Unexpected edit"); }, deleteEntry: () => { throw new Error("Unexpected delete"); } },
  };
  const maple = {
    state, care: store, api, now: () => NOW, refresh: async () => {},
    readOnly: false, online: true, units: "us", timerBusy: () => false,
    member: () => MEMBER, memberName: () => MEMBER.display_name, memberLabel: () => MEMBER.display_name,
    toast: (text) => calls.current.push({ kind: "toast", text }), toasts: [], dismissToast: () => {},
  };
  const thread = {
    ready: true, threadId: "synthetic-thread", earlier: [], messages: [], more: false, loadingEarlier: false,
    loadingHistory: false, historyProblem: null, recovering: false, recoveryPaused: false,
    status: "ready", busy: false, problem: null, help: false, queue: [], queuePaused: false,
    queueLimit: 10, storageProblem: false, awaitingAnswer: false, draft, setDraft,
    send: (text) => calls.current.push({ kind: "send", text }),
    clearProblem: () => {}, approve: () => {}, answerQuestion: () => {}, retryHistory: () => {},
    loadEarlier: async () => false, remove: async () => {},
  };
  useEffect(() => {
    window.__nutritionChat = {
      snapshot: () => ({ ...latest.current, calls: calls.current, consent: consents.current }),
      switchIdentity: (change) => setState((current) => ({
        ...current,
        family: { ...current.family, ...(change.family ? { id: change.family } : {}) },
        me: { ...current.me, ...(change.email ? { email: change.email } : {}) },
        baby: { ...current.baby, ...(change.baby ? { id: change.baby } : {}) },
      })),
    };
  }, []);
  return <FixtureContext.Provider value={{ maple, care, thread }}>
    <AppNavProvider><ChatNavProvider><Contents care={care} /></ChatNavProvider></AppNavProvider>
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
