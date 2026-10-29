import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import MedicalRecordsSettings, { useMedicalRecordsAvailable } from "../../src/components/maple/settings/MedicalRecordsSettings";
import GrowthSheet from "../../src/components/maple/sheets/GrowthSheet";
import EntryRow from "../../src/components/maple/EntryRow";
import { FixtureContext } from "./mocks";

const identity = { name: "River Test", birthDate: "2026-01-01" };
const measurements = [
  { id: "synthetic-weight", label: "Weight", originalDate: "2026-01-15", measuredAt: "2026-01-15T17:00:00Z", originalValue: 3.5, originalUnit: "kg", data: { weight_g: 3500, at: "doctor" } },
  { id: "synthetic-length", label: "Length", originalDate: "2026-01-15T10:30:00-05:00", measuredAt: "2026-01-15T15:30:00Z", originalValue: 52, originalUnit: "cm", data: { length_cm: 52, at: "doctor" } },
];

function scenarioStatus(config) {
  return {
    enabled: config.enabled !== false,
    provider: config.enabled === false ? null : { id: config.sandbox ? "sandbox" : "albany-med", name: config.sandbox ? "Epic test records" : "Albany Med", sandbox: !!config.sandbox },
    importedCount: config.importedCount ?? 0,
    lastImportedAt: config.importedCount ? "2026-01-15T17:00:00Z" : null,
    pending: !config.stage ? null : {
      id: config.pendingId ?? "synthetic-pending",
      stage: config.stage,
      expiresAt: new Date(Date.now() + (config.expired ? -60_000 : 600_000)).toISOString(),
      patient: config.mismatch ? { name: "Other Test", birthDate: "2000-01-01" } : identity,
      baby: identity,
      matchesBirthDate: !config.mismatch,
      measurements: config.stage === "measurements" ? config.empty ? [] : measurements : undefined,
      skipped: config.skipped ?? 0,
    },
  };
}

function Availability() {
  const visible = useMedicalRecordsAvailable();
  return <p data-testid="availability">{visible ? "available" : "hidden"}</p>;
}

function Fixture() {
  const [config, setConfig] = useState({ stage: "patient" });
  const [epoch, setEpoch] = useState(0);
  const current = useRef({ config, status: scenarioStatus(config), calls: [], failures: {}, refreshes: 0 });
  const api = useCallback(async (path, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const value = current.current;
    value.calls.push({ path, method, body });
    const failure = value.failures[`${method} ${path}`];
    if (failure) { delete value.failures[`${method} ${path}`]; throw new Error("Synthetic request failed. Try again."); }
    if (path.endsWith("/review")) {
      value.status = scenarioStatus({ ...value.config, stage: "measurements" });
      return value.status;
    }
    if (path.endsWith("/start")) return { url: `${window.location.origin}/synthetic-mychart` };
    if (path.endsWith("/import") && method === "POST") {
      value.status = { ...value.status, pending: null, importedCount: value.status.importedCount + body.measurementIds.length, lastImportedAt: new Date().toISOString() };
      return { imported: body.measurementIds.length, duplicates: 0 };
    }
    if (path.endsWith("/import") && method === "DELETE") value.status = { ...value.status, importedCount: 0 };
    else if (method === "DELETE") value.status = { ...value.status, pending: null };
    return structuredClone(value.status);
  }, []);
  const refresh = useCallback(async () => { current.current.refreshes++; }, []);
  useEffect(() => {
    window.__epicFixture = {
      scenario: value => {
        current.current = { config: value, status: scenarioStatus(value), calls: [], failures: value.failures ?? {}, refreshes: 0 };
        Object.defineProperty(navigator, "userAgent", { configurable: true, value: value.native ? "Maple-Native-App/1.1 (ios)" : "Synthetic browser" });
        // Tests may switch between sheets with the same heading and no loader.
        // Finish the new scenario's render before exposing it to assertions.
        flushSync(() => { setConfig(value); setEpoch(count => count + 1); });
      },
      snapshot: () => structuredClone(current.current),
    };
  }, []);
  const maple = {
    api, refresh, units: "metric", readOnly: !!config.viewer,
    now: () => new Date("2026-01-20T17:00:00Z"), member: () => null, memberName: () => "Test parent",
    remove: async id => { current.current.calls.push({ method: "remove", id }); },
    state: { family: { id: 42 }, me: { role: config.viewer ? "viewer" : "owner", email: "synthetic@example.test" }, baby: { id: 99, name: identity.name, timezone: "America/New_York" }, members: [] },
  };
  const imported = { id: 10, kind: "growth", source: "epic", started_at: "2026-01-15T17:00:00Z", created_at: "2026-01-20T17:00:00Z", updated_at: "2026-01-20T17:00:00Z", created_by: "synthetic@example.test", updated_by: null, ended_at: null, active: false, data: { weight_g: 3500, length_cm: 52, head_cm: 35, at: "doctor" }, note: "Imported from Albany Med Health System. Measured 2026-01-15: 3.5 kg." };
  return <FixtureContext.Provider value={maple}>
    {config.entryRow ? <EntryRow entry={imported} now={new Date("2026-01-20T17:00:00Z")} onClick={() => {}} /> : config.growth ? <GrowthSheet key={epoch} open kind="growth" entry={imported} onClose={() => { current.current.calls.push({ method: "close" }); }} /> : <>
      {!config.snapshot && <Availability key={`availability-${epoch}`} />}
      <div className={config.snapshot ? "space-y-6 px-4 pt-6 pb-8" : undefined}>
        {config.snapshot && <h1 className="text-[34px] font-semibold leading-tight text-mp-ink">Medical records</h1>}
        <MedicalRecordsSettings key={epoch} />
      </div>
    </>}
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
