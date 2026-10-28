import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import CareScreen from "../../src/components/maple/care/CareScreen";
import { MessageView } from "../../src/components/maple/chat/ChatParts";
import { ToastHost } from "../../src/components/maple/ui";
import { ApiError, FixtureContext } from "./mocks";

const NOW = new Date("2026-10-28T13:30:00.000Z");
const EMAIL = "sam@example.test";
const initialState = () => ({
  baby: { name: "River", nickname: null, sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", settings: {} },
  family: { id: 99, care_name: "Sam", ask: "an owner" },
  me: { email: EMAIL }, members: [{ email: EMAIL, display_name: "Sam", role: "owner" }], entries: [],
  care: {
    person: { member: EMAIL, name: "Sam", self: true, created_by: EMAIL },
    access: { self: true, read: true, write: true, private: true, mood: false, therapist: false, manage: true },
    settings: { checkin_suggestions: false, feeding: "yes" }, plans: [], entries: [],
  },
});

function App() {
  const [state, setState] = useState(initialState);
  const [units, setUnits] = useState("us");
  const [toasts, setToasts] = useState([]);
  const [approval, setApproval] = useState(null);
  const latest = useRef({ state, toasts });
  latest.current = { state, toasts };
  const server = useRef([]);
  const removed = useRef([]);
  const requests = useRef([]);
  const queued = useRef([]);
  const revision = useRef(0);
  const temporary = useRef(0);
  const toastId = useRef(0);
  const fail = useRef(null);
  const delayed = useRef(null);
  const nextVersion = () => new Date(NOW.getTime() + ++revision.current * 1000).toISOString();
  const api = useCallback(async (pathname, init = {}) => {
    const url = new URL(pathname, "https://synthetic.example.test");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const id = Number(url.searchParams.get("id"));
    requests.current.push({ path: url.pathname, method, id: id || null, body, query: url.search, family: init.headers?.["X-Maple-Family"] });
    if (delayed.current) await new Promise((resolve) => { delayed.current = resolve; });
    if (fail.current) { const error = fail.current; fail.current = null; throw error; }
    if (url.pathname === "/api/maple/care/entries/restore") {
      const entry = removed.current.find((item) => item.id === id);
      server.current.push(entry);
      return { entry };
    }
    if (url.pathname !== "/api/maple/care/entries") throw new ApiError(400, "Unexpected fixture endpoint");
    if (method === "POST") {
      const entry = {
        id: 1000 + revision.current, kind: body.kind, med_id: null, at: body.at,
        data: body.data, note: body.note ?? null, private: false, created_by: EMAIL,
        updated_by: null, source: "web", created_at: NOW.toISOString(), updated_at: nextVersion(),
      };
      server.current.push(entry);
      return { created: true, entry, notes: [] };
    }
    if (method === "GET") {
      const from = url.searchParams.get("from");
      return { entries: server.current.filter((entry) => entry.at.startsWith(from)), tz: "America/New_York" };
    }
    const existing = server.current.find((entry) => entry.id === id);
    if (!existing) throw new ApiError(404, "This entry was removed", { reason: "discarded", deleted_by: "alex@example.test" });
    if (method === "PATCH") {
      if (body.expect_updated_at !== existing.updated_at) throw new ApiError(409, "This entry changed on another device");
      const { expect_updated_at, ...changes } = body;
      const entry = { ...existing, ...changes, updated_by: EMAIL, updated_at: nextVersion() };
      server.current = server.current.map((item) => item.id === id ? entry : item);
      return { entry, notes: [] };
    }
    if (method === "DELETE") {
      removed.current.push(existing);
      server.current = server.current.filter((entry) => entry.id !== id);
      return {};
    }
    throw new ApiError(400, "Unexpected fixture write");
  }, []);
  const toast = useCallback((text, options = {}) => {
    const item = { id: ++toastId.current, text, tone: "ok", ...options };
    setToasts([item]);
    return item.id;
  }, []);
  const store = useMemo(() => ({
    patch: (update) => setState((current) => current.care ? ({ ...current, care: update(current.care) }) : current),
    track: (fn) => fn(), tempId: () => --temporary.current,
    queue: (input, entry) => {
      queued.current.push({ input, entry });
      setState((current) => ({ ...current, care: { ...current.care, entries: [{ ...entry, pending: true }, ...current.care.entries] } }));
    },
    unqueue: (id) => {
      if (!queued.current.some(({ entry }) => entry.id === id)) return false;
      queued.current = queued.current.filter(({ entry }) => entry.id !== id);
      setState((current) => ({ ...current, care: { ...current.care, entries: current.care.entries.filter((entry) => entry.id !== id) } }));
      return true;
    },
  }), []);
  const clock = useCallback(() => NOW, []);
  const refresh = useCallback(async () => {}, []);
  const maple = {
    state, care: store, api, toast, now: clock, refresh, toasts, units,
    dismissToast: (id) => setToasts((all) => all.filter((item) => item.id !== id)),
    readOnly: !state.care?.access.write, memberLabel: () => "Sam", memberName: () => "Sam",
    summary: { age: { dayOfLife: 28, days: 27, label: "4 weeks" } },
  };
  useEffect(() => {
    window.__nutritionFixture = {
      snapshot: () => ({ state: latest.current.state, server: server.current, requests: requests.current, queued: queued.current }),
      clearToasts: () => setToasts([]),
      setUnits,
      poll: () => setState((current) => ({ ...current, care: { ...current.care, entries: [...current.care.entries] } })),
      seedHistory: () => {
        server.current = [{ id: 8001, kind: "food", at: "2026-10-24T13:00:00.000Z", data: { description: "Lentil toast", meal: "meal", items: [{ name: "Lentils", portion: "Half a cup", nutrients: { protein_g: 9, fiber_g: 8, energy_kcal: 115 }, groups: ["legumes", "protein"], source: "estimate", note: "Synthetic estimate" }] }, note: "Synthetic meal note", updated_at: NOW.toISOString() }];
      },
      offline: () => { fail.current = new TypeError("Offline"); },
      reject: () => { fail.current = new ApiError(400, "That entry could not be saved"); },
      pauseRequest: () => { delayed.current = true; },
      resumeRequest: () => { const resume = delayed.current; delayed.current = null; if (typeof resume === "function") resume(); },
      signOut: () => setState((current) => ({ ...current, care: null })),
      switchFamily: () => setState((current) => ({ ...current, family: { ...current.family, id: 100, care_name: "Casey" }, care: { ...current.care, person: { ...current.care.person, member: "casey@example.test", name: "Casey" }, entries: [] } })),
      viewOnly: () => setState((current) => ({ ...current, care: { ...current.care, access: { ...current.care.access, write: false } } })),
      showApproval: (kind) => {
        const entry = { id: 7001, kind, at: NOW.toISOString(), data: kind === "food" ? { description: "Oatmeal and berries", meal: "meal" } : { name: "Herbal tea", amount_ml: 250 }, updated_at: NOW.toISOString() };
        setState((current) => ({ ...current, care: { ...current.care, entries: [entry] } }));
        setApproval({ id: "synthetic-approval", role: "assistant", parts: [{ type: "tool-fix_mom_entry", toolCallId: `delete-${kind}`, state: "approval-requested", input: { id: "c7001", delete: true }, approval: { id: `approval-${kind}` } }] });
      },
      changeElsewhere: (id) => {
        server.current = server.current.map((entry) => entry.id === id ? { ...entry, data: { ...entry.data, description: "Updated meal" }, updated_at: nextVersion() } : entry);
        setState((current) => ({ ...current, care: { ...current.care, entries: [...server.current] } }));
      },
    };
  }, []);
  return <FixtureContext.Provider value={maple}>
    <main className="mx-auto min-h-screen max-w-lg">{approval ? <MessageView message={approval} last busy={false} onApprove={() => {}} onAnswerQuestion={() => {}} /> : <CareScreen />}</main>
    <ToastHost />
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
