import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ThemeProvider from "../../src/components/ThemeProvider";
import { deviceId } from "../../src/lib/maple/device";
import ChatSetting from "../../src/components/maple/chat/ChatSetting";
import ChatNavigation from "../../src/components/maple/chat/ChatNavigation";
import { useSectionFocus } from "../../src/components/maple/sectionFocus";
import { FixtureContext, ApiError } from "./mocks";

const initial = { v: 1, scope: "family", babyId: 99, key: "track_pump", label: "Pumping", previous: true, value: false, status: "proposed" };
const refs = { threadId: "synthetic-thread", messageId: "synthetic-message", toolCallId: "synthetic-tool" };
function Destination({ page }) {
  useSectionFocus(page === "care" ? "care" : "family");
  return <div><div style={{ height: 1400 }}>Synthetic {page}</div>{["baby-details", "doctor-contacts", "phone-preferences", "mom-medicines"].map(id => <section key={id} id={id} tabIndex={-1}>{id}</section>)}</div>;
}
function Fixture() {
  const [config, setConfig] = useState({ kind: "setting", setting: initial });
  const [epoch, setEpoch] = useState(0);
  const [units, setUnits] = useState("us");
  const [page, setPage] = useState("chat");
  const pending = useRef(null);
  const calls = useRef([]);
  const latest = useRef({ config, units, page }); latest.current = { config, units, page };
  const api = async (path, opts) => {
    const body = JSON.parse(opts.body); calls.current.push({ kind: "api", path, body });
    return new Promise((resolve, reject) => {
      pending.current = success => {
        pending.current = null;
        if (!success) return reject(new ApiError(503, "Synthetic unavailable"));
        const setting = latest.current.config.setting;
        const next = { ...setting, previous: body.phonePrevious ?? setting.previous, status: body.action === "undo" ? "undone" : "applied", changedAt: new Date().toISOString() };
        setConfig(c => ({ ...c, setting: next })); resolve({ setting: next, text: "Synthetic saved setting" });
      };
    });
  };
  const maple = { state: config.baby ? { baby: config.baby } : null, units, setUnits: value => { calls.current.push({ kind: "units", value }); setUnits(value); }, online: config.online !== false, readOnly: !!config.viewer, api, refresh: async () => {} };
  const app = { tab: page, go: target => { calls.current.push({ kind: "go", target }); setPage(target); } };
  const notifications = { value: "Off", open: () => calls.current.push({ kind: "notifications" }) };
  const careNav = { openDoctor: () => calls.current.push({ kind: "doctor" }), openHelp: () => calls.current.push({ kind: "help" }) };
  const sheets = { open: value => calls.current.push({ kind: "sheet", value }) };
  useEffect(() => {
    window.__settingsFixture = {
      scenario: raw => {
        const next = { ...raw };
        if (next.setting?.scope === "phone" && !next.setting.phoneDevice) next.setting = { ...next.setting, phoneDevice: deviceId() };
        setConfig(next); setEpoch(n => n + 1); setPage("chat"); setUnits("us"); pending.current = null; calls.current = [];
      },
      resolve: success => pending.current?.(success),
      snapshot: () => ({ ...latest.current, calls: calls.current, pending: !!pending.current, focused: document.activeElement?.id }),
      units: value => setUnits(value),
    };
  }, []);
  return <FixtureContext.Provider value={{ maple, app, notifications, careNav, sheets, care: config.care === false || config.viewer ? null : {} }}>
    {page === "chat"
      ? config.kind === "navigation" ? <ChatNavigation key={epoch} navigation={{ v: 1, destination: config.destination }} /> : <ChatSetting key={epoch} {...refs} setting={config.setting} busy={config.busy} />
      : <Destination page={page} />}
  </FixtureContext.Provider>;
}
createRoot(document.getElementById("root")).render(<ThemeProvider><Fixture /></ThemeProvider>);
