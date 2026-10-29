import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import FamilyTab from "@/components/maple/FamilyTab";
import Onboarding from "@/components/maple/onboarding/Onboarding";
import { InviteLinks } from "@/components/maple/onboarding/MoreSteps";
import { FixtureContext } from "./mocks.jsx";

const NOW = new Date("2026-10-28T13:00:00Z");
const onboardingView = {
  familyId: 99, status: "onboarding", owner: true,
  done: { welcome: "answered", you: "answered", timezone: "answered" },
  next: "baby_name", canFinish: false, missing: ["birth"], modelSteps: 0,
  values: { you: { name: "Juniper", role_word: "Parent" }, timezone: { timezone: "America/New_York", units: "us" }, baby: null, feeding: null, invites: 0, care: null, pediatrician: null, notifications: null },
};
const member = { email: "alex@example.test", display_name: "Alex", role: "owner", emoji: null };
const baby = {
  id: 99, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York",
  born_at: "2026-10-28T16:00:00.000Z", due_date: "2026-10-28",
  birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { birth_time_approx: true },
};

function App() {
  const view = new URLSearchParams(location.search).get("view");
  const [state, setState] = useState({ baby, family: { id: 99, care_name: "Alex", ask: "an owner" }, entries: [], members: [member], me: member });
  const [units, setUnits] = useState("us");
  const [online, setOnline] = useState(true);
  const [toasts, setToasts] = useState([]);
  const calls = useRef([]);
  const latest = useRef(null);
  latest.current = { state, toasts };
  const toast = useCallback((text) => setToasts((all) => [...all, text]), []);
  const api = useCallback(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.current.push({ url, method: options.method ?? "GET", body });
    const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json" } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Synthetic failure");
    if (url === "/api/maple/baby" && body) setState((previous) => {
      const settings = { ...previous.baby.settings, ...body.settings };
      for (const key of Object.keys(settings)) if (settings[key] === null) delete settings[key];
      return { ...previous, baby: { ...previous.baby, ...body, settings } };
    });
    return result;
  }, []);
  const maple = {
    state: view?.endsWith("waiting") ? null : state, units, setUnits, now: () => NOW, api, refresh: async () => {}, toast,
    readOnly: false, auth: { member: view === "invite-waiting" ? { ...member, email: "invite:41" } : member }, online,
    memberName: (id) => state.members.find((person) => person.email === id)?.display_name ?? "Guest",
    member: (id) => state.members.find((person) => person.email === id) ?? null,
    memberLabel: () => "Alex", log: async () => null, toasts: view?.endsWith("waiting") ? toasts.map((text, id) => ({ text, id, tone: "error" })) : [], dismissToast() {},
  };
  useEffect(() => {
    window.__settingsFixture = {
      snapshot: () => ({ ...latest.current, calls: calls.current }),
      setOnline,
      setBaby: (patch) => setState((previous) => ({ ...previous, baby: { ...previous.baby, ...patch } })),
    };
  }, []);
  return <FixtureContext.Provider value={{ maple, care: { self: false, name: "Alex", rows: [] }, now: NOW }}>
    {view === "links"
      ? <InviteLinks links={[{ name: "Helper Synthetic", role: "viewer", url: "https://onboarding-recovery.example.test/maple/join#synthetic-onboarding-link" }]} />
      : view === "draft"
        ? <Onboarding initial={onboardingView} onDone={() => {}} />
        : view?.endsWith("waiting")
          ? <Onboarding initial={{ ...onboardingView, owner: false }} onDone={() => {}} />
          : <FamilyTab />}
    {!view?.endsWith("waiting") && <div role="status">{toasts.at(-1)}</div>}
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
