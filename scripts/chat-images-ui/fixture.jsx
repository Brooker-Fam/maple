import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ChatTab from "../../src/components/maple/chat/ChatTab";
import { setShownFamily } from "../../src/components/maple/shownFamily";
import { ApiError, FixtureContext } from "../chat-ui-check/mocks";

const api = async (url, init) => {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body.error ?? "Synthetic request failed", body);
  return body;
};
function App() {
  const [online, setOnline] = useState(true);
  const [terms, setTerms] = useState(true);
  const [family, setFamily] = useState(99);
  const [active, setActive] = useState(true);
  const value = useMemo(() => ({
    maple: {
      state: { baby: { id: family, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York", settings: {} }, family: { id: family, care_name: "Sam", ask: "an owner" }, entries: [], me: { email: "alex@example.test", role: "owner" }, members: [], care: null },
      api, refresh: async () => {}, online, readOnly: false, units: "us", now: () => new Date("2026-10-29T16:00:00.000Z"),
      toast: () => {}, toasts: [], dismissToast: () => {}, memberName: () => "Alex", memberLabel: () => "Alex",
    },
    chatNav: { consent: { terms, care: false, self: false }, loadConsent: () => {}, saveConsent: async () => true, termsNeeded: () => setTerms(false) },
    nav: { openHelp: () => {}, openCare: () => {}, openSupport: () => {}, openDoctor: () => {} },
    sheets: { open: () => {}, close: () => {}, current: null }, appNav: { go: () => {} },
  }), [online, terms, family]);
  useEffect(() => { setShownFamily(family); }, [family]);
  useEffect(() => { window.__imageFixture = { setOnline, setTerms, setFamily, setActive }; }, []);
  return <FixtureContext.Provider value={value}><ChatTab active={active} /></FixtureContext.Provider>;
}
createRoot(document.getElementById("root")).render(<App />);
