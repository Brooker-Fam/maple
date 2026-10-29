import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import MomentSheet from "../../src/components/maple/sheets/MomentSheet";
import MomentsTab from "../../src/components/maple/MomentsTab";
import { AppNavProvider } from "../../src/components/maple/AppNav";
import { ApiError, FixtureContext } from "./mocks";
import { setNightActive } from "../../src/components/maple/nightLook";

const now = "2026-10-28T13:30:00.000Z";
const original = { id: 901, kind: "moment", started_at: now, ended_at: null, active: false, note: "A synthetic memory", source: "web", created_by: "synthetic@example.test", updated_by: null, updated_at: now, created_at: now,
  data: { title: "Example photo", photos: [{ id: "a".repeat(32), w: 600, h: 800 }, { id: "b".repeat(32), w: 800, h: 600 }] } };
const query = new URLSearchParams(location.search);
const mode = query.get("mode") || "gallery";
function Fixture() {
  const [open, setOpen] = useState(true);
  const [record, setRecord] = useState(original);
  const calls = useRef([]);
  const [revision, setRevision] = useState(0);
  const api = async (path, options) => {
    if (options?.method === "PATCH") {
      const patch = JSON.parse(options.body);
      calls.current.push({ patch });
      if (window.__failSave) throw new ApiError("Synthetic failure", 503, {});
      if (window.__conflict) {
        const latest = { ...original, updated_at: "2026-10-28T13:31:00.000Z", data: { ...original.data, title: "Latest family caption" } };
        setRecord(latest);
        throw new ApiError("Changed", 409, { entry: latest, reason: "changed" });
      }
      const next = { ...record, ...patch, data: { ...record.data, ...patch.data }, updated_at: "2026-10-28T13:32:00.000Z" };
      setRecord(next);
      return { entry: next };
    }
    return { entries: [record], next_cursor: null };
  };
  const state = { rev: String(revision), now, family: { id: 99 }, baby: { name: "Example Baby", sex: "female", born_at: "2026-09-01T12:00:00.000Z", timezone: "America/New_York", settings: {} }, entries: mode === "guest" ? [] : [record], members: [], me: { email: "synthetic@example.test", role: mode === "guest" ? "photos" : "owner" } };
  const value = { state, api, now: () => new Date(now), readOnly: mode === "guest", memberName: () => "Example parent", memberLabel: () => "Example parent", member: () => null, toast() {}, refresh: async () => { setRevision((value) => value + 1); },
    log: async (input) => { calls.current.push({ log: input }); return input; }, update: async (id, patch) => (await api(`entries?id=${id}`, { method: "PATCH", body: JSON.stringify(patch) })).entry, remove() {},
  };
  useEffect(() => { window.__photoFixture = { calls: () => calls.current, night: () => { document.documentElement.classList.add("maple-night"); setNightActive(true); } }; }, []);
  return <FixtureContext.Provider value={value}><main className="mx-auto min-h-screen max-w-lg"><button type="button">Background action</button>
    {mode === "gallery" || mode === "guest" ? <MomentsTab /> : <MomentSheet open={open} onClose={() => setOpen(false)} entry={mode === "new" ? undefined : original} />}
  </main></FixtureContext.Provider>;
}
const app = <AppNavProvider><Fixture /></AppNavProvider>;
createRoot(document.getElementById("root")).render(mode === "strict" ? <StrictMode>{app}</StrictMode> : app);
