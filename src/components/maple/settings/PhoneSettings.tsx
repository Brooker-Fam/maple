"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { isNativeApp } from "@/lib/maple/native";
import { Icon } from "../icons";
import { useNightPref, type NightPref } from "../nightLook";
import { Segmented, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { GROUP, Section } from "./parts";

function SegmentRow({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className={cx(tone.body, "text-[15px]")}>{label}</span>
        <div className="ml-auto w-[13.5rem] max-w-full">{children}</div>
      </div>
      {note && <p className={cx(tone.muted, "mt-2 text-[13px] leading-snug")}>{note}</p>}
    </div>
  );
}

export default function PhoneSettings() {
  const { units, setUnits } = useMaple();
  const [night, setNight] = useNightPref();
  const { theme, setTheme } = useTheme();
  const [standalone, setStandalone] = useState(true);
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setStandalone(isNativeApp() || window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true);
  }, []);

  return (
    <>
      <Section title="Appearance" id="phone-preferences">
        <div className={GROUP}>
          <SegmentRow label="Theme">
            <Segmented
              aria-label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </SegmentRow>
          <SegmentRow
            label="Night look"
            note={
              night === "auto"
                ? "Switches to dim amber from 8pm to 7am."
                : night === "always"
                  ? "Uses dim amber instead of your theme."
                  : "Uses your theme throughout the day and night."
            }
          >
            <Segmented<NightPref>
              aria-label="Night look"
              value={night}
              onChange={setNight}
              options={[
                { value: "auto", label: "Auto" },
                { value: "always", label: "Always" },
                { value: "off", label: "Off" },
              ]}
            />
          </SegmentRow>
        </div>
      </Section>
      <Section title="Measurements" footnote="These preferences stay on this device. Everyone else keeps their own.">
        <div className={GROUP}>
          <SegmentRow label="Units">
            <Segmented
              aria-label="Measurement units"
              value={units}
              onChange={setUnits}
              options={[
                { value: "us", label: "lb · oz · °F" },
                { value: "metric", label: "kg · ml · °C" },
              ]}
            />
          </SegmentRow>
        </div>
      </Section>
      {!standalone && (
        <details className="group border-t border-mp-line">
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center gap-3 px-1 text-[15px] text-mp-ink [&::-webkit-details-marker]:hidden">
            <Icon name="share" size={20} className="shrink-0 text-mp-ink-2" />
            <span className="flex-1">Add Maple to your Home Screen</span>
            <Icon name="chevron-down" size={18} className="shrink-0 text-mp-ink-3 group-open:rotate-180" />
          </summary>
          <p className={cx(tone.muted, "px-1 pb-3 text-sm leading-relaxed")}>
            On iPhone, open Maple in Safari, tap <strong className="font-semibold text-mp-ink">Share</strong>, then{" "}
            <strong className="font-semibold text-mp-ink">Add to Home Screen</strong>.
          </p>
        </details>
      )}
    </>
  );
}
