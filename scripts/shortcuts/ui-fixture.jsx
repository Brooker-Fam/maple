import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import AssistantSettings from "../../src/components/maple/settings/AssistantSettings";
import { FixtureContext } from "../ui-review-settings-mocks";

function App() {
  const [toasts, setToasts] = useState([]);
  const calls = useRef([]);
  const tokens = useRef(new URLSearchParams(location.search).has("existing") ? [{ id: 401, label: "My iPhone", created_at: "2026-10-28T10:00:00Z", last_used_at: "2026-10-29T10:00:00Z" }, { id: 402, label: "My iPhone 3", created_at: "2026-10-28T11:00:00Z", last_used_at: null }] : []);
  const fail = useRef(new URLSearchParams(location.search).has("fail"));
  const api = useCallback(async (url, options = {}) => {
    calls.current.push({ url, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
    if (fail.current) { fail.current = false; throw new Error("Synthetic load error"); }
    if (options.method === "POST") {
      const record = { id: 501, label: "My iPhone", created_at: "2026-10-29T10:00:00Z", last_used_at: null };
      tokens.current.push(record);
      return { token: "maple_synthetic_ui_check", record };
    }
    if (options.method === "DELETE") tokens.current = [];
    return { tokens: [...tokens.current] };
  }, []);
  window.__siriFixture = { calls: () => calls.current };
  const maple = {
    api, toast: (message) => setToasts((previous) => [...previous, message]), now: () => new Date("2026-10-29T12:00:00Z"),
    readOnly: false, state: { family: { id: 99 }, baby: { name: "Synthetic Baby", nickname: "Baby", sex: null, settings: {} }, me: { email: "parent@example.test", role: "owner" } },
  };
  return <FixtureContext.Provider value={{ maple, care: null }}><main className="mx-auto max-w-lg space-y-7 p-5"><AssistantSettings /></main><div role="status">{toasts.join(" ")}</div></FixtureContext.Provider>;
}
createRoot(document.getElementById("root")).render(<App />);
