"use client";

import { useTheme } from "@/components/ThemeProvider";
import { settingInputSchema, type PhoneSettingKey, type SettingValue } from "@/lib/maple/chat/settings";
import { useNightPref } from "../nightLook";
import { useMaple } from "../useMaple";

/** Uses the same providers as Family settings; no separate chat-only preference store. */
export function usePhoneSettings() {
  const { units, setUnits } = useMaple();
  const [night, setNight] = useNightPref();
  const { theme, setTheme } = useTheme();
  const values = { units, night, theme };
  return {
    values,
    set: (key: PhoneSettingKey, value: SettingValue) => {
      const parsed = settingInputSchema.safeParse({ key, value });
      if (!parsed.success) throw new Error("That choice isn't available.");
      const input = parsed.data;
      if (input.key === "units") setUnits(input.value);
      else if (input.key === "night") setNight(input.value);
      else if (input.key === "theme") setTheme(input.value);
      else throw new Error("That choice isn't for this phone.");
    },
  };
}
