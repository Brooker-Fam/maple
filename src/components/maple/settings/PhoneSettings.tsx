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
    <Section title="On this phone" id="phone-preferences">
      <div className={GROUP}>
        <SegmentRow label="Units">
          <Segmented
            value={units}
            onChange={setUnits}
            options={[
              { value: "us", label: "lb · oz · °F" },
              { value: "metric", label: "kg · ml · °C" },
            ]}
          />
        </SegmentRow>
        <SegmentRow
          label="Night look"
          note={
            night === "auto"
              ? "Dim amber from 8pm to 7am, easy on sleepy eyes."
              : night === "always"
                ? "Dim amber all the time."
                : "Follows the light or dark theme below."
          }
        >
          <Segmented<NightPref>
            value={night}
            onChange={setNight}
            options={[
              { value: "auto", label: "Auto" },
              { value: "always", label: "Always" },
              { value: "off", label: "Off" },
            ]}
          />
        </SegmentRow>
        <SegmentRow label="Theme">
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "system", label: "Auto" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </SegmentRow>
        {!standalone && (
          <div className="flex gap-3 px-4 py-3.5">
            <Icon name="share" size={20} className="mt-0.5 shrink-0 text-mp-accent-fg" />
            <p className={cx(tone.muted, "text-sm leading-relaxed")}>
              <strong className="font-semibold text-mp-ink">Add Maple&apos;s Log to your Home Screen</strong> for one-tap logging. On iPhone, open
              this page in Safari, tap <strong className="font-semibold text-mp-ink">Share</strong>, then{" "}
              <strong className="font-semibold text-mp-ink">Add to Home Screen</strong>.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
