"use client";

import { DEVELOPMENT_TOPICS } from "@/lib/maple/guidelines/development";
import { Icon } from "../icons";
import { Toggle } from "../settings/parts";
import { cx, tone } from "../ui";
import { useDiscoveryPreferences } from "./useDiscoveryPreferences";

export default function DiscoveryPreferences() {
  const { preferences, update, ready } = useDiscoveryPreferences();
  return (
    <div className="space-y-5">
      <div className={tone.card}>
        <Toggle label="Show on Today" hint="One small discovery each day. No notifications." checked={preferences.enabled} disabled={!ready} onChange={(enabled) => update({ enabled })} />
      </div>
      <fieldset disabled={!ready} className="space-y-3">
        <legend className={cx(tone.heading, "text-[17px]")}>What would you like ideas about?</legend>
        <p className={cx(tone.muted, "text-sm")}>Choose a few, or enjoy a little of everything. You can change this anytime.</p>
        <button type="button" aria-pressed={preferences.topics.length === 0} onClick={() => update({ topics: [] })} className={cx("flex min-h-[48px] w-full items-center gap-3 rounded-xl border px-4 text-left text-[15px]", preferences.topics.length === 0 ? "border-mp-accent-fg bg-mp-sunken text-mp-accent-fg" : "border-mp-line text-mp-ink")}>
          <Icon name="leaf" size={19} /><span className="flex-1">A little of everything</span>{preferences.topics.length === 0 && <Icon name="check" size={18} />}
        </button>
        <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
          {DEVELOPMENT_TOPICS.map((topic) => (
            <label key={topic.id} className="flex min-h-[52px] cursor-pointer items-center gap-3 px-4 py-3 text-[15px] text-mp-ink">
              <span className="flex-1">{topic.label}</span>
              <input type="checkbox" checked={preferences.topics.includes(topic.id)} onChange={(event) => update({ topics: event.target.checked ? [...preferences.topics, topic.id] : preferences.topics.filter((id) => id !== topic.id) })} className="h-5 w-5 accent-mp-accent-fg" />
            </label>
          ))}
        </div>
      </fieldset>
      <p className={cx(tone.faint, "text-[13px] leading-relaxed")}>These choices stay in this browser for your account and family. They change which discoveries you see, not your family&apos;s log.</p>
    </div>
  );
}
