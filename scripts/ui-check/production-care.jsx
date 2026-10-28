// The real Today dose action, toast, care navigation, picker and editor run here.
// Only the app store and HTTP boundary are synthetic; no labels/actions are copied.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Dock from "../../src/components/maple/Dock";
import { CareNavProvider } from "../../src/components/maple/care/CareNav";
import { ToastHost } from "../../src/components/maple/ui";
import { ApiError, CareFixtureContext } from "./care-mocks";

const NOW = new Date("2026-10-28T13:30:00.000Z");
const EMAIL = "sam@example.test";
const plan = {
  id: 901, name: "Example medicine", also_called: null, dose_text: "Example label",
  schedule: { type: "every", every_min: 360 }, max_24h: null, limit_unit: null,
  units_per_dose: null, label_text: null, reason: null, contains_apap: false,
  instructions: null, course_start: null, course_end: null, show_on_today: true,
  private: false, stopped_at: null, reviewed_at: null, reviewed_by: null, sort: 0,
  created_by: EMAIL, updated_by: null, source: "web", created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};
const initialCare = () => ({
  person: { member: EMAIL, name: "Sam", self: true, created_by: EMAIL },
  access: { self: true, read: true, write: true, private: true, mood: false, therapist: false, manage: true },
  settings: { checkin_suggestions: false }, plans: [plan], entries: [],
});
const initialState = () => ({
  baby: { name: "River", nickname: null, sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", settings: {} },
  family: { id: 99, care_name: "Sam", ask: "an owner" },
  me: { email: EMAIL }, members: [{ email: EMAIL, display_name: "Sam", role: "owner" }],
  entries: [], care: initialCare(),
});

function App() {
  const [state, setState] = useState(initialState);
  const [toasts, setToasts] = useState([]);
  const latest = useRef({ state, toasts });
  latest.current = { state, toasts };
  const server = useRef([]);
  const requests = useRef([]);
  const originalEdit = useRef(null);
  const revision = useRef(0);
  const temporary = useRef(0);
  const toastId = useRef(0);
  const nextVersion = () => new Date(NOW.getTime() + ++revision.current * 1000).toISOString();
  const api = useCallback(async (pathname, init = {}) => {
    const url = new URL(pathname, "https://synthetic.example.test");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.current.push({ path: url.pathname, method, id: Number(url.searchParams.get("id")) || null, body });
    if (url.pathname !== "/api/maple/care/entries") throw new ApiError(400, "Unexpected fixture endpoint");
    if (method === "POST") {
      const entry = {
        id: 1001 + server.current.length, kind: body.kind, med_id: body.med_id, at: body.at,
        data: { ...body.data, dose: body.data.dose ?? plan.dose_text }, note: body.note,
        private: body.private, created_by: EMAIL, updated_by: null, source: "web",
        created_at: NOW.toISOString(), updated_at: nextVersion(),
      };
      server.current = [...server.current, entry];
      return { created: true, entry, notes: [] };
    }
    if (method === "PATCH") {
      const id = Number(url.searchParams.get("id"));
      const existing = server.current.find((entry) => entry.id === id);
      if (!existing) throw new ApiError(404, "This example dose no longer exists");
      if (body.expect_updated_at !== existing.updated_at) throw new ApiError(409, "This example dose changed on another device");
      const { expect_updated_at, ...changes } = body;
      const entry = { ...existing, ...changes, updated_by: EMAIL, updated_at: nextVersion() };
      server.current = server.current.map((item) => item.id === id ? entry : item);
      return { entry, notes: [] };
    }
    throw new ApiError(400, "Unexpected fixture write");
  }, []);
  const toast = useCallback((text, options = {}) => {
    const item = { id: ++toastId.current, text, tone: "ok", ...options };
    const edit = item.actions?.find((action) => action.label === "Edit time");
    if (edit && !originalEdit.current) originalEdit.current = edit.onClick;
    setToasts([item]);
  }, []);
  const store = useMemo(() => ({
    patch: (update) => setState((current) => ({ ...current, care: update(current.care) })),
    track: (fn) => fn(), tempId: () => --temporary.current, unqueue: () => false,
    queue: () => { throw new Error("Unexpected offline queue in online regression"); },
  }), []);
  const clock = useCallback(() => NOW, []);
  const refresh = useCallback(async () => {}, []);
  const maple = {
    state, care: store, api, toast, now: clock, refresh, toasts,
    dismissToast: (id) => setToasts((all) => all.filter((item) => item.id !== id)),
    readOnly: false, units: "imperial", memberLabel: () => "Sam", memberName: () => "Sam",
    summary: { active: [], nextSide: "L", age: { dayOfLife: 28 }, today: { tummySec: 0 } },
    timerBusy: () => false,
  };
  useEffect(() => {
    window.__productionCareFixture = {
      snapshot: () => ({ state: latest.current.state, server: server.current, requests: requests.current }),
      clearToasts: () => setToasts([]),
      replayOriginalEdit: () => originalEdit.current?.(),
      addSameTimeDose: () => {
        const source = server.current.find((entry) => entry.id === 1001);
        const other = { ...source, id: 2002, updated_at: nextVersion() };
        server.current = [other, ...server.current];
        setState((current) => ({ ...current, care: { ...current.care, entries: [other, ...current.care.entries] } }));
      },
      removeOriginal: () => {
        server.current = server.current.filter((entry) => entry.id !== 1001);
        setState((current) => ({ ...current, care: { ...current.care, entries: current.care.entries.filter((entry) => entry.id !== 1001) } }));
      },
      // Simulates a later poll. Reloading clears the temporary hold and toasts,
      // while the saved dose remains accessible in the real medicine picker.
      seedSaved: (entries) => {
        server.current = structuredClone(entries);
        setState((current) => ({ ...current, care: { ...current.care, entries: structuredClone(entries) } }));
      },
    };
  }, []);
  return <CareFixtureContext.Provider value={maple}>
    <CareNavProvider>
      <main className="mx-auto min-h-screen max-w-lg px-4 py-6 pb-80">
        <p className="text-[13px] text-mp-ink-2">Example family · synthetic records</p>
        <h1 className="mt-1 text-[32px] font-semibold text-mp-ink">Today</h1>
        <p className="mt-2 text-mp-ink-2">River · 4 weeks old</p>
        <section className="mt-6 rounded-2xl bg-mp-surface p-4 ring-1 ring-(--mp-edge)">
          <h2 className="font-semibold text-mp-ink">A quiet morning</h2>
          <p className="mt-1 text-sm text-mp-ink-2">Synthetic family. No real records are used.</p>
        </section>
      </main>
      <Dock />
      <nav aria-label="Example tabs" className="fixed inset-x-0 bottom-0 flex h-[57px] items-center justify-around border-t border-mp-line bg-mp-bg text-sm text-mp-ink-2"><span className="font-semibold text-mp-accent-fg">Today</span><span>Log</span><span>Family</span></nav>
      <ToastHost />
    </CareNavProvider>
  </CareFixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
