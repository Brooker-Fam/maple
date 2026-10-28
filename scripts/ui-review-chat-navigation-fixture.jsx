import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppNavProvider, useAppNav } from "../src/components/maple/AppNav";
import FamilyTab from "../src/components/maple/FamilyTab";
import ChatNavigation from "../src/components/maple/chat/ChatNavigation";
import ChatSetting from "../src/components/maple/chat/ChatSetting";
import { useSectionFocus } from "../src/components/maple/sectionFocus";
import { FixtureContext } from "./ui-review-settings-mocks";

const NOW = new Date("2026-10-28T13:00:00Z");
const viewer = new URLSearchParams(location.search).has("viewer");
const member = { email: "alex@example.test", display_name: "Alex", role: viewer ? "viewer" : "owner", emoji: null };
const baby = { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York", born_at: "2026-10-20T12:00:00Z", due_date: "2026-10-20", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { pediatrician_phone: "202-555-0125", pediatrician_name: "Example Pediatrics", feeds_bottle: true } };
const proposals = [
  { key: "baby_name", label: "Baby's name", previous: "Earlier Example", value: "Later Example" },
  { key: "pediatrician_phone", label: "Pediatrician phone", previous: "202-555-0100", value: "202-555-0120" },
  { key: "pediatrician_name", label: "Pediatrician", previous: "Earlier Practice", value: "Later Practice" },
  { key: "feeds_bottle", label: "Bottles", previous: false, value: false },
];

function CareSection() {
  useSectionFocus("care");
  return <section id="mom-medicines" tabIndex={-1}><h1>Medicines</h1></section>;
}

function Frame() {
  const app = useAppNav();
  useEffect(() => { window.__navigationFixture = { go: app.go }; }, [app.go]);
  return <>
    <nav>{["chat", "family", "today"].map((tab) => <button key={tab} onClick={() => app.go(tab)}>{tab} tab</button>)}</nav>
    <output data-tab>{app.tab}</output>
    <div hidden={app.tab !== "chat"}>
      {["baby_profile", "pediatrician", "phone_preferences", "mom_medicines", "family_settings"].map((destination) => <ChatNavigation key={destination} navigation={{ v: 1, destination }} />)}
      {proposals.map((proposal) => <ChatSetting key={proposal.key} threadId="synthetic-thread" messageId="synthetic-message" toolCallId={proposal.key} setting={{ ...proposal, v: 1, scope: "family", status: "proposed", babyId: 99 }} />)}
    </div>
    {app.tab === "family" && <FamilyTab />}
    {app.tab === "care" && <CareSection />}
  </>;
}

function App() {
  const [units, setUnits] = useState("us");
  const [state, setState] = useState({ baby, family: { id: 99, care_name: "Alex", ask: "an owner" }, entries: [], members: [member], me: member });
  const [toast, setToast] = useState("");
  const calls = useRef([]);
  const fail = useRef(false);
  useEffect(() => { window.__navigationData = { calls: () => calls.current, failNext: () => { fail.current = true; } }; }, []);
  const api = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.current.push({ url, method: options.method, body });
    if (fail.current) { fail.current = false; throw new Error("Synthetic save failed. Try again."); }
    if (url !== "/api/maple/baby" || options.method !== "PATCH") throw new Error("Unexpected synthetic API request");
    setState((previous) => ({ ...previous, baby: { ...previous.baby, settings: { ...previous.baby.settings, ...body.settings } } }));
    return {};
  };
  const maple = { state, units, setUnits, now: () => NOW, api, refresh: async () => {}, toast: setToast, readOnly: viewer, auth: {}, online: true, memberName: () => "Alex", member: () => member, memberLabel: () => "Alex" };
  return <FixtureContext.Provider value={{ maple, care: viewer ? null : { self: false, name: "Alex", rows: [] }, now: NOW }}><AppNavProvider><Frame /><div role="status">{toast}</div></AppNavProvider></FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
