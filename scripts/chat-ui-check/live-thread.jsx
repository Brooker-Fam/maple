import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ChatTab from "../../src/components/maple/chat/ChatTab";
import { ApiError, FixtureContext } from "./mocks";

// This fixture keeps the real chat hook and SDK transport. Only the app store
// and HTTP server are synthetic; the runner supplies stored history and SSE.
const NOW = "2026-10-28T16:00:00.000Z";
const api = async (url, init) => {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body.error ?? "Synthetic request failed", body);
  return body;
};
function App() {
  const [online, setOnline] = useState(true);
  const value = useRef({
    maple: {
      state: { baby: { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York", settings: {} }, family: { id: 99, care_name: "Sam", ask: "an owner" }, entries: [], me: { email: "alex@example.test", role: "owner" }, members: [], care: null },
      api, refresh: async () => {}, online: true, readOnly: false, units: "us", now: () => new Date(NOW),
      toast: () => {}, toasts: [], dismissToast: () => {}, memberName: () => "Alex", memberLabel: () => "Alex",
    },
    chatNav: { consent: { terms: true, care: false, self: false }, loadConsent: () => {}, saveConsent: async () => true, termsNeeded: () => {} },
    nav: { openHelp: () => {}, openCare: () => {}, openSupport: () => {}, openDoctor: () => {} },
    sheets: { open: () => {}, close: () => {}, current: null },
    appNav: { go: () => {} },
  }).current;
  value.maple.online = online;
  useEffect(() => { window.__chatLiveFixture = { setOnline }; }, []);
  return <FixtureContext.Provider value={value}><ChatTab active /></FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
