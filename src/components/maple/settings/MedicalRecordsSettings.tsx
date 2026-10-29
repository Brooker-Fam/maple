"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { isNativeApp } from "@/lib/maple/native";
import { MAPLE_HOST } from "@/lib/maple/origin";
import { formatLength, formatWeight } from "@/lib/maple/units";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { DANGER_TEXT, GROUP, Row, Section } from "./parts";
import { useSettingsDraft } from "./DraftContext";

type Measurement = {
  id: string;
  measuredAt: string;
  originalDate: string;
  label: string;
  originalValue: number;
  originalUnit: string;
  data: { weight_g?: number; length_cm?: number; head_cm?: number; at: "doctor" };
};

export type MedicalRecordsStatus = {
  enabled: boolean;
  provider: { id: "sandbox" | "albany-med"; name: string; sandbox: boolean } | null;
  importedCount: number;
  lastImportedAt: string | null;
  pending: null | {
    id: string;
    stage: "patient" | "measurements";
    expiresAt: string;
    patient: { name: string; birthDate: string | null };
    baby: { name: string; birthDate: string | null };
    matchesBirthDate: boolean;
    measurements?: Measurement[];
    skipped?: number;
  };
};

const ENDPOINT = "/api/maple/epic";
const CHANGED = "maple-medical-records-changed";
const CALLBACK_ERRORS: Record<string, string> = {
  denied: "MyChart access wasn't approved. You can try again whenever you're ready.",
  expired: "That connection expired. Connect to MyChart again to continue.",
  failed: "We couldn't finish connecting to MyChart. Please try again.",
};

/** No patient information is kept in the navigation's availability state. */
export function useMedicalRecordsAvailable(): boolean {
  const { api, state } = useMaple();
  const scope = state?.me.role === "owner" ? `${state.family?.id ?? 1}:${state.me.email}:${state.baby.id}` : "";
  const [availability, setAvailability] = useState({ scope: "", visible: false });
  useEffect(() => {
    if (!scope) return;
    let live = true;
    const load = () => {
      void api<MedicalRecordsStatus>(ENDPOINT).then((status) => {
        if (live) setAvailability({ scope, visible: status.enabled || status.importedCount > 0 });
      }).catch(() => {
        if (live) setAvailability({ scope, visible: false });
      });
    };
    load();
    window.addEventListener(CHANGED, load);
    return () => { live = false; window.removeEventListener(CHANGED, load); };
  }, [api, scope]);
  return !!scope && availability.scope === scope && availability.visible;
}

function birthDate(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Birth date unavailable";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}

function measurementDate(value: Measurement, tz: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.originalDate)) return birthDate(value.originalDate);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(value.measuredAt));
}

function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return <label className={cx("flex min-h-[52px] items-start gap-3 py-3", disabled && "opacity-60")}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-mp-accent" />
    <span className={cx(tone.body, "min-w-0 text-[15px] leading-relaxed")}>{children}</span>
  </label>;
}

/** Owner-only, deliberate import. The pending record stays out of the family log until confirmed. */
export default function MedicalRecordsSettings({ active = true }: { active?: boolean }) {
  const { api, refresh, state, units } = useMaple();
  const [status, setStatus] = useState<MedicalRecordsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [native, setNative] = useState(false);
  const owner = state?.me.role === "owner";
  const scope = `${state?.family?.id ?? 1}:${state?.me.email ?? ""}:${state?.baby.id ?? ""}`;
  const loadedScope = useRef("");
  const reviewKey = useRef("");

  const apply = useCallback((next: MedicalRecordsStatus) => {
    loadedScope.current = scope;
    setStatus(next);
    const nextKey = next.pending ? `${scope}:${next.pending.id}:${next.pending.stage}:${next.pending.expiresAt}` : "";
    if (nextKey !== reviewKey.current || !next.pending) {
      setConfirmed(false);
      setSharing(false);
      setSelected(new Set(next.pending?.measurements?.map((measurement) => measurement.id) ?? []));
    }
    reviewKey.current = nextKey;
    setNow(Date.now());
  }, [scope]);
  const load = useCallback(async () => {
    setLoading(true);
    try { apply(await api<MedicalRecordsStatus>(ENDPOINT)); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load medical records. Try again."); }
    finally { setLoading(false); }
  }, [api, apply]);

  useEffect(() => {
    if (!active || !owner) return;
    setNative(isNativeApp());
    let live = true;
    setLoading(true);
    const url = new URL(window.location.href);
    const callback = url.searchParams.get("epic");
    if (callback) {
      setError(CALLBACK_ERRORS[callback] ?? null);
      url.searchParams.delete("epic");
      window.history.replaceState(window.history.state, "", url);
    }
    void api<MedicalRecordsStatus>(ENDPOINT).then((next) => { if (live) apply(next); }).catch((e) => {
      if (live) setError(e instanceof Error ? e.message : "Couldn't load medical records. Try again.");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [active, owner, api, apply]);

  const pending = loadedScope.current === scope ? status?.pending : null;
  const changedSelection = pending?.stage === "measurements" && selected.size !== (pending.measurements?.length ?? 0);
  useSettingsDraft("medical-records", active && !busy && !!pending && (confirmed || sharing || !!changedSelection));
  useEffect(() => {
    if (!active || !pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [active, pending]);

  if (!owner) return <p className={tone.muted}>Only a family owner can import medical records.</p>;

  const expired = !!pending && Date.parse(pending.expiresAt) <= now;
  const provider = status?.provider;
  const blocked = !!busy || expired || !status?.enabled || native;
  const patientAllowed = !!provider?.sandbox || !!pending?.matchesBirthDate;
  const tz = state?.baby.timezone ?? "America/New_York";
  const run = async (action: string, work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(action);
    setError(null);
    setNotice(null);
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't finish that. Please try again."); }
    finally { running.current = false; setBusy(null); }
  };
  const connect = () => run("connect", async () => {
    const result = await api<{ url: string }>(`${ENDPOINT}/start`, { method: "POST", body: "{}" });
    window.location.assign(result.url);
  });
  const discard = () => run("discard", async () => {
    await api(ENDPOINT, { method: "DELETE", body: JSON.stringify({ pendingId: pending?.id }) });
    apply(await api<MedicalRecordsStatus>(ENDPOINT));
    setNotice("The pending connection was discarded. Nothing was added to the log.");
  });
  const review = () => run("review", async () => {
    const next = await api<MedicalRecordsStatus>(`${ENDPOINT}/review`, { method: "POST", body: JSON.stringify({ pendingId: pending?.id, confirmPatient: true }) });
    apply(next);
  });
  const save = () => run("import", async () => {
    const result = await api<{ imported: number; duplicates: number }>(`${ENDPOINT}/import`, {
      method: "POST", body: JSON.stringify({ pendingId: pending?.id, measurementIds: [...selected], shareWithFamilyAndAssistants: true }),
    });
    apply(await api<MedicalRecordsStatus>(ENDPOINT));
    await refresh();
    window.dispatchEvent(new Event(CHANGED));
    setNotice(`${result.imported} measurement${result.imported === 1 ? "" : "s"} added to the growth log.${result.duplicates ? ` ${result.duplicates} already imported; no duplicates were added.` : ""}`);
  });
  const remove = () => run("delete", async () => {
    await api(`${ENDPOINT}/import`, { method: "DELETE", body: "{}" });
    apply(await api<MedicalRecordsStatus>(ENDPOINT));
    await refresh();
    setDeleting(false);
    window.dispatchEvent(new Event(CHANGED));
    setNotice("Your imported measurements were removed from Maple. Your medical record at the provider is unchanged.");
  });

  return <div className="space-y-6">
    {error && <div role="alert" className={cx(tone.card, "space-y-2 border border-mp-danger/25 p-4")}>
      <p className="text-[15px] leading-relaxed text-mp-danger">{error}</p>
      {!status && <Button variant="soft" disabled={!!busy || loading} onClick={() => { setError(null); void load(); }}>Try again</Button>}
    </div>}
    {notice && <p role="status" className={cx(tone.card, "p-4 text-[15px] leading-relaxed")}>{notice}</p>}
    {loading && <p role="status" className={tone.muted}>Loading medical records…</p>}
    {!loading && status && <>
      {native && <p className={cx(tone.card, "p-4 text-[15px] leading-relaxed")}>Open {MAPLE_HOST} in Safari or Chrome to import medical records. Saved measurements will appear here.</p>}
      {provider?.sandbox && <div className={cx(tone.card, "space-y-2 p-4")}>
        <p className={cx(tone.body, "font-semibold")}>Test records only</p>
        <p className={cx(tone.muted, "text-[15px] leading-relaxed")}>This connection uses Epic&apos;s test records. You can review sample measurements, but they cannot be saved to your family&apos;s log.</p>
      </div>}

      {!status.enabled && <p className={cx(tone.muted, "text-[15px] leading-relaxed")}>Medical record imports aren&apos;t available right now. Any measurements you already imported remain in the log.</p>}

      {!pending && status.enabled && <Section title={provider?.name ?? "Medical records"} footnote="Each import asks you to sign in to MyChart. Maple does not keep an ongoing connection or your MyChart password.">
        <div className={cx(GROUP, "space-y-4 p-4")}>
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>Bring weight, length and head measurements into {state?.baby.nickname || state?.baby.name}&apos;s growth log. Choose the baby&apos;s record in MyChart, then review the measurements before saving.</p>
          <Button disabled={!!busy || native} onClick={() => void connect()}>{busy === "connect" ? "Opening MyChart…" : status.importedCount ? "Import latest measurements" : `Connect ${provider?.sandbox ? "test MyChart" : "Albany Med"}`}</Button>
        </div>
      </Section>}

      {pending && <>
        {expired && <p role="alert" className="text-[15px] leading-relaxed text-mp-danger">This review has expired. Connect to MyChart again to continue.</p>}
        <Section title={pending.stage === "patient" ? "Confirm the baby’s record" : "Review measurements"} footnote={`From ${provider?.name ?? "MyChart"}. These details are visible only to you until you choose measurements to add to the family log.`}>
          <div className={GROUP}>
            <Row label={pending.patient.name} note={birthDate(pending.patient.birthDate)} />
            {pending.stage === "patient" && <div className="space-y-2 px-4 pb-4">
              <p className={cx(tone.muted, "pt-3 text-[13px] leading-relaxed")}>This Maple log belongs to {pending.baby.name}, born {birthDate(pending.baby.birthDate)}.</p>
              {!patientAllowed && <p role="alert" className="text-[15px] leading-relaxed text-mp-danger">The birth dates don&apos;t match, or a birth date is missing. Check the baby&apos;s birth details in Maple and select the baby&apos;s own record in MyChart before continuing.</p>}
              <Check checked={confirmed} disabled={blocked || !patientAllowed} onChange={setConfirmed}>{provider?.sandbox ? "I understand this is a synthetic test record." : <>This is {pending.baby.name}&apos;s record, and I&apos;m authorized to access it.</>}</Check>
              <Button disabled={blocked || !patientAllowed || !confirmed} onClick={() => void review()}>{busy === "review" ? "Loading measurements…" : "Review measurements"}</Button>
            </div>}
          </div>
        </Section>

        {pending.stage === "measurements" && <Section title="Choose what to add" footnote={pending.skipped ? `${pending.skipped} unsupported or incomplete record${pending.skipped === 1 ? " was" : "s were"} left out. This list may not include every measurement in MyChart.` : "Previously imported measurements will not be added again. Check for any measurements you already entered by hand."}>
          {pending.measurements?.length ? <>
            <div className={GROUP}>
              {pending.measurements.map((measurement) => {
                const data = measurement.data;
                const value = data.weight_g != null ? formatWeight(data.weight_g, units) : formatLength(data.length_cm ?? data.head_cm, units);
                return <div key={measurement.id} className="px-4">
                  <Check checked={selected.has(measurement.id)} disabled={blocked} onChange={(checked) => setSelected((previous) => {
                    const next = new Set(previous);
                    if (checked) next.add(measurement.id); else next.delete(measurement.id);
                    return next;
                  })}>
                    <span className="block font-medium">{measurement.label}: {value}</span>
                    <span className={cx(tone.muted, "block text-[13px]")}>{measurementDate(measurement, tz)}</span>
                  </Check>
                </div>;
              })}
            </div>
            <Check checked={sharing} disabled={blocked || provider?.sandbox} onChange={setSharing}>I want the selected measurements added to the family log, where other family members, including viewers, can see them and Maple chat and connected assistants can use them.</Check>
            <Button disabled={blocked || provider?.sandbox || !sharing || selected.size === 0} onClick={() => void save()}>{busy === "import" ? "Adding measurements…" : `Add ${selected.size} measurement${selected.size === 1 ? "" : "s"}`}</Button>
          </> : <p className={cx(tone.card, "p-4 text-[15px] leading-relaxed")}>No supported growth measurements were returned for this record. Nothing has been added to Maple. You can still enter a measurement by hand.</p>}
        </Section>}

        <div className="flex flex-wrap gap-2">
          {status.enabled && (expired || !patientAllowed) && <Button disabled={!!busy || native} onClick={() => void connect()}>{busy === "connect" ? "Opening MyChart…" : "Connect again"}</Button>}
          <Button variant="ghost" disabled={!!busy} onClick={() => void discard()}>{busy === "discard" ? "Discarding…" : "Discard pending connection"}</Button>
        </div>
      </>}

      {status.importedCount > 0 && <Section title="Imported into Maple" footnote="This count includes copies removed from the timeline. These controls permanently remove the measurements you imported into this family’s Maple log. They do not change anything in MyChart or remove copies already shared elsewhere.">
        <div className={GROUP}>
          <Row label={`${status.importedCount} imported measurement${status.importedCount === 1 ? "" : "s"}`} note={status.lastImportedAt ? `Last import ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz }).format(new Date(status.lastImportedAt))}` : undefined} />
          {!deleting ? <div className="px-4"><button type="button" className={DANGER_TEXT} disabled={!!busy} onClick={() => setDeleting(true)}>Remove my imported measurements</button></div> : <div className="space-y-3 p-4">
            <p className={cx(tone.body, "text-[15px] leading-relaxed")}>Permanently remove all {status.importedCount} measurements you imported into this family&apos;s log? This cannot be undone.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" disabled={!!busy} onClick={() => void remove()}>{busy === "delete" ? "Removing…" : "Remove permanently"}</Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => setDeleting(false)}>Keep measurements</Button>
            </div>
          </div>}
        </div>
      </Section>}
    </>}
  </div>;
}
