import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import FamilyTab from "../src/components/maple/FamilyTab";
import BirthSheet from "../src/components/maple/BirthSheet";
import Onboarding from "../src/components/maple/onboarding/Onboarding";
import { BirthStep } from "../src/components/maple/onboarding/BasicSteps";
import { InvitesStep } from "../src/components/maple/onboarding/MoreSteps";
import { birthProblem } from "../src/lib/maple/onboarding/steps";
import { FixtureContext } from "./ui-review-settings-mocks";

const NOW = new Date("2026-10-28T13:00:00Z");
const onboardingView = { familyId: 99, status: "onboarding", owner: true, done: { welcome: "answered", you: "answered", timezone: "answered" }, next: "baby_name", canFinish: false, missing: ["birth"], modelSteps: 0, values: { you: { name: "Juniper", role_word: "Parent" }, timezone: { timezone: "America/New_York", units: "us" }, baby: null, feeding: null, invites: 0, care: null, pediatrician: null, notifications: null } };
const member = { email: "alex@example.test", display_name: "Alex", role: "owner", emoji: null };
const baby = { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York", born_at: "2026-10-28T16:00:00.000Z", due_date: "2026-10-28", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { birth_time_approx: true } };

function App() {
  const [state, setState] = useState({ baby, family: { id: 99, care_name: "Alex", ask: "an owner" }, entries: [], members: [member], me: member });
  const [units, setUnits] = useState("us");
  const [birthOpen, setBirthOpen] = useState(new URLSearchParams(location.search).get("view") === "birth");
  const [toasts, setToasts] = useState([]);
  const [onboardingProblem, setOnboardingProblem] = useState(null);
  const view = new URLSearchParams(location.search).get("view");
  const onboarding = { busy: false, problem: onboardingProblem, answer: (step, answer) => {
    const problem = step === "birth" ? birthProblem(answer, "Asia/Tokyo", new Date()) : null;
    setOnboardingProblem(problem);
    if (!problem) calls.current.push({ url: "synthetic:onboarding", method: "ANSWER", step, answer });
  }, skip() {} };
  const calls = useRef([]);
  const latest = useRef(null);
  const fail = useRef(false);
  latest.current = { state, toasts };
  const toast = (text) => setToasts((all) => [...all, text]);
  const api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.current.push({ url, method: options.method ?? "GET", body });
    if (fail.current && options.method) { fail.current = false; throw new Error("Synthetic save failed. Try again."); }
    if (url === "/api/maple/baby" && body) setState((previous) => {
      const settings = { ...previous.baby.settings, ...body.settings };
      for (const key of Object.keys(settings)) if (settings[key] === null) delete settings[key];
      return { ...previous, baby: { ...previous.baby, ...body, settings } };
    });
    return { invites: [], tokens: [], entries: [] };
  };
  const maple = {
    state, units, setUnits, now: () => NOW, api, refresh: async () => {}, toast, readOnly: state.me.role === "viewer", auth: {}, online: true,
    memberName: (id) => state.members.find((person) => person.email === id)?.display_name ?? "Guest",
    member: (id) => state.members.find((person) => person.email === id) ?? null,
    memberLabel: () => "Alex", log: async () => null, toasts: [], dismissToast() {},
  };
  useEffect(() => {
    window.__settingsFixture = {
      snapshot: () => ({ ...latest.current, calls: calls.current }),
      failNext: () => { fail.current = true; },
      openBirth: () => setBirthOpen(true),
      asGuest: () => setState((previous) => ({ ...previous, me: { email: "invite:501", display_name: "Helper", role: "viewer" }, members: [member, { email: "invite:501", display_name: "Helper", role: "viewer" }] })),
    };
  }, []);
  return <FixtureContext.Provider value={{ maple, care: state.me.role === "viewer" ? null : { self: false, name: "Alex", rows: [] }, now: NOW }}>
    {view === "draft" ? <Onboarding initial={onboardingView} onDone={() => {}} /> : view === "onboarding" ? <><BirthStep ob={onboarding} view={{ done: {}, values: { baby: null, timezone: { timezone: "Asia/Tokyo", units: "us" } } }} /><InvitesStep ob={onboarding} /></> : <FamilyTab />}
    <BirthSheet open={birthOpen} onClose={() => setBirthOpen(false)} mode="edit" />
    <div role="status">{toasts.at(-1)}</div>
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
