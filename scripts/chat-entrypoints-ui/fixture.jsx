import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppNavProvider, useAppNav } from "../../src/components/maple/AppNav";
import { ChatNavProvider, useChatNav } from "../../src/components/maple/chat/ChatNav";
import ChatTab from "../../src/components/maple/chat/ChatTab";
import DiaperSheet from "../../src/components/maple/sheets/DiaperSheet";
import FeedSheet from "../../src/components/maple/sheets/FeedSheet";
import { FixtureContext } from "./mocks";

const NOW = "2026-10-28T16:00:00.000Z";
const MEMBER = { email: "alex@example.test", display_name: "Alex Example", role: "owner" };
const ENTRY = {
  id: 901, kind: "diaper", started_at: "2026-10-27T02:10:00.000Z", ended_at: null, active: false,
  data: { pee: true, poop: false }, note: "Synthetic saved note", source: "app",
  created_by: MEMBER.email, updated_by: null, created_at: NOW, updated_at: NOW,
};
const FEED = {
  ...ENTRY, kind: "feed", ended_at: "2026-10-27T02:20:00.000Z",
  data: { method: "breast", first_side: "L", segments: [{ side: "L", start: ENTRY.started_at, end: "2026-10-27T02:20:00.000Z" }] },
};

function Contents({ open, entry, close, bindNavigation, sheetKind }) {
  const nav = useAppNav();
  const chatNav = useChatNav();
  const [visitedChat, setVisitedChat] = useState(false);
  useEffect(() => {
    if (nav.tab === "chat") setVisitedChat(true);
  }, [nav.tab]);
  useEffect(() => {
    bindNavigation(nav, chatNav);
  }, [nav, chatNav, bindNavigation]);
  const EntrySheet = sheetKind === "feed" ? FeedSheet : DiaperSheet;
  return <>
    <main hidden={nav.tab === "chat"} className="min-h-screen bg-mp-bg p-5">
      <h1 className="mb-6 text-3xl text-mp-ink">Today</h1>
      <button type="button" className="min-h-11 rounded-xl bg-mp-surface p-3 text-mp-ink" onClick={open}>Open saved entry</button>
    </main>
    {(visitedChat || nav.tab === "chat") && <ChatTab active={nav.tab === "chat"} />}
    <nav aria-label="Fixture tabs" className="fixed inset-x-0 bottom-0 z-[70] flex h-[57px] justify-around bg-mp-surface text-mp-ink">
      <button type="button" onClick={() => nav.go("today")}>Today tab</button>
      <button type="button" onClick={() => nav.go("chat")}>Chat tab</button>
      {nav.tab === "chat" && <button type="button" onClick={open}>Open saved entry</button>}
    </nav>
    <EntrySheet open={!!entry} entry={entry ?? undefined} kind={sheetKind} onClose={close} />
  </>;
}

function App() {
  const options = new URLSearchParams(window.location.search);
  const [entry, setEntry] = useState(null);
  const [draft, setDraft] = useState(options.get("draft") ?? "");
  const [identity, setIdentity] = useState({ family: 99, baby: 99, email: MEMBER.email });
  const bridge = useRef({});
  const calls = useRef([]);
  const terms = useRef(options.get("terms") !== "false");
  const viewer = options.get("role") === "viewer";
  const savedEntry = options.get("sheet") === "feed" ? FEED : ENTRY;
  const entryId = options.get("entry") === "pending" ? -901 : ENTRY.id;
  const close = useCallback(() => setEntry(null), [setEntry]);
  const bindNavigation = useCallback((nav, chatNav) => {
    bridge.current = { nav, chatNav };
  }, []);
  const open = () => setEntry({ ...savedEntry, id: entryId });
  const api = useCallback(async (url, init) => {
    if (url !== "/api/maple/chat/consent") throw new Error(`Unexpected synthetic API: ${url}`);
    calls.current.push({ kind: "consent", method: init?.method ?? "GET" });
    if (init?.method === "POST") terms.current = JSON.parse(init.body).terms === true;
    return { terms: terms.current, care: false, self: false };
  }, []);
  const maple = {
    state: {
      family: { id: identity.family, ask: "an owner" },
      baby: { id: identity.baby, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", settings: {} },
      me: { ...MEMBER, email: identity.email, role: viewer ? "viewer" : "owner" }, members: [MEMBER], entries: [savedEntry], care: null,
    },
    api, now: () => new Date(NOW), readOnly: viewer, online: true, units: "us",
    member: () => MEMBER, memberName: () => MEMBER.display_name, memberLabel: () => MEMBER.display_name,
    toast: () => {}, toasts: [], dismissToast: () => {},
    log: () => { throw new Error("Unexpected log write"); },
    update: () => { throw new Error("Unexpected log write"); },
    remove: () => { throw new Error("Unexpected log write"); },
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
    window.__entrypoints = {
      calls: () => calls.current,
      ask: (value) => bridge.current.chatNav.ask(value),
      navigate: (value) => bridge.current.nav.go(value),
      switchIdentity: (value) => setIdentity((current) => ({ ...current, ...value })),
      setDraft,
    };
  }, []);
  return <FixtureContext.Provider value={{
    maple, thread,
    careNav: { openHelp: () => {}, openCare: () => {}, openSupport: () => {}, openDoctor: () => {} },
    sheets: { open: ({ entry: value }) => setEntry(value), close, current: entry },
  }}>
    <AppNavProvider><ChatNavProvider><Contents open={open} entry={entry} close={close} bindNavigation={bindNavigation} sheetKind={savedEntry.kind} /></ChatNavProvider></AppNavProvider>
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
