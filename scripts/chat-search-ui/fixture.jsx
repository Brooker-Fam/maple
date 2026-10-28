import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ChatEntries from "../../src/components/maple/chat/ChatEntries";
import { FixtureContext } from "./mocks";

export const RESULTS = {
  version: 1, asOf: "2026-10-28T16:00:00.000Z", timezone: "America/New_York",
  criteria: { query: "hiccups", kind: "note", from: "2025-10-28", to: "2026-10-28", after: null, before: null, doctorQuestions: true, includeAnswered: true, limit: 10 },
  entries: [{ id: 901, kind: "note", startedAt: "2026-10-28T14:00:00.000Z", summary: "Synthetic question: hiccups after feeding?", question: true, done: false }],
  nextCursor: "synthetic_next_page",
};

function App() {
  const [scenario, setScenario] = useState("member");
  const [epoch, setEpoch] = useState(0);
  const [draft, setDraft] = useState("");
  const calls = useRef([]);
  const request = async (url, init) => {
    calls.current.push({ type: "api", url, method: init?.method ?? "GET" });
    const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  };
  useEffect(() => {
    window.__searchUi = {
      reset(value) { setScenario(value); setEpoch((n) => n + 1); calls.current = []; },
      calls: () => calls.current,
      results: RESULTS,
    };
  }, []);
  const value = {
    maple: {
      api: request, online: scenario !== "offline", readOnly: scenario === "viewer",
      state: { family: { id: 1 }, baby: { timezone: RESULTS.timezone } },
      now: () => new Date(RESULTS.asOf),
      update: async (id, patch) => {
        calls.current.push({ type: "update", id, patch });
        try { return (await request(`/api/maple/entries?id=${id}`, { method: "PATCH", body: JSON.stringify(patch) })).entry; } catch { return null; }
      },
    },
    sheets: { open: (value) => calls.current.push({ type: "edit", value }) },
    nav: { go: (value) => calls.current.push({ type: "nav", value }) },
  };
  return <FixtureContext.Provider value={value}>
    <main className="min-h-screen bg-mp-bg p-4"><h1 className="mb-4 text-2xl font-semibold text-mp-ink">Chat</h1>
      <ChatEntries key={epoch} results={RESULTS} disabled={scenario === "busy"} />
      <label className="mt-4 block text-sm text-mp-ink">Message<textarea aria-label="Message" value={draft} onChange={(e) => setDraft(e.target.value)} className="mt-2 block w-full rounded-xl border border-mp-line bg-mp-surface p-3" /></label>
    </main>
  </FixtureContext.Provider>;
}
createRoot(document.getElementById("root")).render(<App />);
