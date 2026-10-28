import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import MomentsTab from "../src/components/maple/MomentsTab";
import { AppNavProvider, useAppNav } from "../src/components/maple/AppNav";
import { milestoneLabel, NEUTRAL_MILESTONE_WORDS } from "../src/lib/maple/milestones";
import { FixtureContext } from "./ui-review-moments-mocks";

const NOW = "2026-10-28T13:30:00.000Z";
const AT = "2026-10-01T12:00:00.000Z";
const moment = (id, extra = {}) => ({ id, kind: "moment", started_at: AT, ended_at: null, active: false, data: { title: `Example moment ${id}`, photos: [] }, note: null, source: "web", created_by: "reader@example.test", updated_by: null, created_at: AT, updated_at: AT, ...extra });
const makeEntries = (scenario) => {
  if (scenario === "pages") return Array.from({ length: 501 }, (_, n) => moment(501 - n, { data: { title: `Example moment ${501 - n}`, photos: [], ...(n === 500 ? { milestone: "first-smile" } : n === 499 ? { milestone: "monthly-1" } : {}) } }));
  if (scenario === "empty") return [];
  return [moment(900, { started_at: "2026-10-28T12:00:00.000Z", data: { title: "Example photo", photos: [{ url: "private-example", w: 800, h: 1000 }] } })];
};

function Fixture() {
  const nav = useAppNav();
  const scenario = new URLSearchParams(location.search).get("scenario") || "photo";
  const records = useRef(makeEntries(scenario));
  const fail = useRef(false);
  const calls = useRef([]);
  const [rev, setRev] = useState(0);
  const [recent, setRecent] = useState(() => scenario === "pages" || scenario === "empty" ? [] : records.current);
  const api = useCallback(async (path) => {
    const url = new URL(path, location.origin);
    if (url.searchParams.get("kind") !== "moment") return { entries: [] };
    calls.current.push(path);
    if (fail.current) throw new Error("Synthetic offline response");
    if (url.searchParams.get("highlights") === "1") return { entries: records.current.filter((m) => m.data.milestone) };
    const before = Number(url.searchParams.get("before_id")) || Infinity;
    const limit = Number(url.searchParams.get("limit")) || 100;
    const eligible = records.current.filter((m) => m.id < before);
    const entries = eligible.slice(0, limit);
    const last = entries.at(-1);
    return { entries, truncated: eligible.length > entries.length, next_cursor: eligible.length > entries.length ? { started_at: last.started_at, id: last.id } : null };
  }, []);
  useEffect(() => {
    window.__momentsFixture = {
      failRefresh() { fail.current = true; setRev((v) => v + 1); },
      allowRefresh() { fail.current = false; },
      editRecent() { setRecent((items) => items.map((entry) => ({ ...entry, data: { ...entry.data, title: "Updated example photo" }, updated_at: NOW }))); },
      calls: () => calls.current,
      labels: () => [milestoneLabel("hello-world", NEUTRAL_MILESTONE_WORDS), milestoneLabel("born", NEUTRAL_MILESTONE_WORDS)],
    };
  }, []);
  const state = { rev: String(rev), now: NOW, family: { id: 99 }, baby: { name: "Example Baby", nickname: null, sex: "female", born_at: "2026-09-01T12:00:00.000Z", timezone: "America/New_York", settings: {} }, entries: recent, members: [], me: { email: "reader@example.test" } };
  return <FixtureContext.Provider value={{ state, api, now: () => new Date(NOW), readOnly: false, memberName: () => "Example parent", member: () => null }}><button type="button">Background action</button>
    {scenario === "navigation" && <nav><button onClick={() => nav.go("today")}>Go to Today</button><button onClick={() => nav.go("moments")}>Go to Moments</button></nav>}
    {(scenario !== "navigation" || nav.tab === "moments") && <MomentsTab />}
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<AppNavProvider><Fixture /></AppNavProvider>);
