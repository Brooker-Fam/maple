"use client";

import { useState } from "react";
import { careTime, forMom, loggedBy } from "@/lib/maple/care";
import { assessMomTemp } from "@/lib/maple/guidelines";
import { DEFAULT_TZ } from "@/lib/maple/time";
import type { CareEntry } from "@/lib/maple/types";
import { cToF, fToC, formatTemp } from "@/lib/maple/units";
import { Icon } from "../icons";
import { AssessmentCard, CHECK_NUMBER_HINT, Label, SheetFooter, useNumberChecks, useOpenCount } from "../sheets/parts";
import { Segmented, Sheet, Stepper, WhenField, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useCareNav } from "./CareNav";
import { GROUP, Problem, errorText } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * Her temperature (§7.1): the row on her tab, and the sheet it opens (one
 * sheet, held by CareNav: the row, her tab's action tile, More and Maple's
 * temperature sheet all open it with useCareNav().openTemp()).
 * assessMomTemp checks the reading as it's typed (100.4°F or higher, or
 * 96.8°F or lower, is a call to her OB now), before Save, and the toast and
 * the MCP repeat it. Stored in °C; shown in °F unless the phone is metric.
 * The reading starts blank: nothing is saved that nobody took.
 */

type TempEntry = Extract<CareEntry, { kind: "temp" }>;

const r1 = (n: number) => Math.round(n * 10) / 10;

function temps(care: UseCare): TempEntry[] {
  return care.state.entries.filter((e): e is TempEntry => e.kind === "temp").sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function TemperatureTile() {
  const care = useCare();
  const nav = useCareNav();
  const { state, now, units } = useMaple();
  if (!care) return null;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const last = temps(care)[0];
  const write = care.access.write;
  return (
    <div>
      <div className={GROUP}>
        <button type="button" onClick={nav.openTemp} className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="thermometer" size={20} className="shrink-0 text-mp-ink-2" />
          <span className={cx(tone.body, "min-w-0 flex-1 text-[15px]")}>Temperature</span>
          {last ? (
            <span className={cx(tone.muted, "shrink-0 text-[15px] tabular-nums")}>
              {formatTemp(last.data.temp_c, units)} · {careTime(last.at, now(), tz)}
              {last.pending ? " · not synced" : ""}
            </span>
          ) : (
            <span className={cx("shrink-0 text-[15px]", write ? "font-medium text-mp-accent-fg" : tone.muted)}>{write ? "Add" : "None yet"}</span>
          )}
          <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
        </button>
      </div>
    </div>
  );
}

/** Her temperature sheet (mounted once, in CareNavProvider). */
export function MomTempSheet(props: { open: boolean; onClose: () => void; care: UseCare }) {
  const n = useOpenCount(props.open);
  return <TempForm key={n} {...props} />;
}

function TempForm({ open, onClose, care }: { open: boolean; onClose: () => void; care: UseCare }) {
  const { state, now, units } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [unit, setUnit] = useState<"F" | "C">(units === "metric" ? "C" : "F");
  const [value, setValue] = useState<number | null>(null);
  const [when, setWhen] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const checks = useNumberChecks();
  const write = care.access.write;

  const switchUnit = (u: "F" | "C") => {
    if (u === unit) return;
    if (value != null) setValue(u === "C" ? r1(fToC(value)) : r1(cToF(value)));
    setUnit(u);
  };

  const tempC = value == null ? null : unit === "C" ? value : fToC(value);
  // Judge only a finished-looking number (not "10" on the way to "100.4"); the server takes 30–45 °C.
  const plausible = tempC != null && tempC >= 32 && tempC <= 43;
  const savable = tempC != null && tempC >= 30 && tempC <= 45;
  const looksLikeC = unit === "F" && value != null && value >= 34 && value <= 43;
  const a = plausible ? assessMomTemp(tempC) : null;
  const note = a ? forMom(a, care.name, care.self) : null;
  const recent = temps(care).slice(0, 6);
  const who = { members: state?.members ?? [], me: state?.me.email };

  const save = async () => {
    if (tempC == null || !savable) return;
    setBusy(true);
    setProblem(null);
    try {
      await care.act.logTemp(Math.round(tempC * 1000) / 1000, (when ?? now()).toISOString());
      onClose();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={care.self ? "Your temperature" : `${care.name}'s temperature`}
      footer={
        write ? (
          <SheetFooter
            onClose={onClose}
            onPrimary={() => void save()}
            label="Save"
            busy={busy}
            disabled={checks.invalid || !savable}
            hint={checks.invalid ? CHECK_NUMBER_HINT : !savable ? "Enter the reading." : undefined}
          />
        ) : undefined
      }
    >
      {write && (
        <>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <Label className="mb-0">Reading</Label>
              <Segmented<"F" | "C">
                value={unit}
                onChange={switchUnit}
                options={[
                  { value: "F", label: "°F" },
                  { value: "C", label: "°C" },
                ]}
                className="w-28"
              />
            </div>
            <Stepper
              value={value}
              onChange={setValue}
              onInvalid={checks.watch("reading")}
              step={0.1}
              decimals={1}
              min={unit === "F" ? 90 : 32}
              max={unit === "F" ? 110 : 43}
              start={unit === "F" ? 98.6 : 37}
              suffix={unit === "F" ? "°F" : "°C"}
              ariaLabel={`temperature in degrees ${unit === "F" ? "Fahrenheit" : "Celsius"}`}
            />
            {looksLikeC && (
              <button
                type="button"
                // The number typed is already °C: relabel it, don't convert it.
                onClick={() => setUnit("C")}
                className="mt-1 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-mp-accent-fg"
              >
                <Icon name="arrow-left-right" size={16} />
                That looks like °C. Switch to °C?
              </button>
            )}
          </div>
          {note && <AssessmentCard a={note} audience="mom" />}
          <WhenField value={when} onChange={setWhen} tz={tz} />
          <Problem>{problem}</Problem>
        </>
      )}
      {recent.length > 0 && (
        <section>
          <Label>Recent readings</Label>
          <div className={GROUP}>
            {recent.map((e) => (
              <div key={e.id} className="flex min-h-[52px] items-center gap-3 py-1.5 pr-1.5 pl-4">
                <span className={cx(tone.body, "min-w-0 flex-1 text-[15px] tabular-nums")}>
                  {formatTemp(e.data.temp_c, unit === "C" ? "metric" : "us")}
                  <span className={tone.muted}>
                    {" "}
                    · {careTime(e.at, now(), tz)} · {loggedBy(e.created_by, who)}
                    {e.pending ? " · not synced" : ""}
                  </span>
                </span>
                {write && e.id > 0 && (
                  <button
                    type="button"
                    aria-label={`Delete the ${formatTemp(e.data.temp_c, unit === "C" ? "metric" : "us")} reading`}
                    onClick={() => void care.act.deleteEntry(e.id).catch(() => {})}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-ink/5"
                  >
                    <Icon name="trash-2" size={18} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </Sheet>
  );
}

export default TemperatureTile;
