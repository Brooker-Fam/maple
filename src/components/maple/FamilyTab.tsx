"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DISCLAIMER } from "@/lib/maple/guidelines";
import AccountMenu from "./AccountMenu";
import { useCareNav } from "./care/CareNav";
import { useCare } from "./care/useCare";
import { ChatCareRow } from "./chat/ChatTerms";
import { Icon, type IconName } from "./icons";
import { NotificationsRow } from "./notify";
import SignInMethods from "./SignInMethods";
import { About, DataAndAccount } from "./settings/AccountSettings";
import AssistantSettings from "./settings/AssistantSettings";
import BabySettings from "./settings/BabySettings";
import PeopleSettings from "./settings/PeopleSettings";
import PhoneSettings from "./settings/PhoneSettings";
import DiscoveryPreferences from "./development/DiscoveryPreferences";
import MedicalRecordsSettings, { useMedicalRecordsAvailable } from "./settings/MedicalRecordsSettings";
import { SettingsDraftContext } from "./settings/DraftContext";
import { ActionRow, GROUP, Section } from "./settings/parts";
import { useSectionFocus } from "./sectionFocus";
import { cx, tone } from "./ui";
import { useMaple } from "./useMaple";

const PAGES = {
  people: "People & permissions",
  baby: "Baby details",
  doctor: "Doctor & care plan",
  "medical-records": "Medical records",
  today: "On Today",
  appearance: "Appearance & units",
  discoveries: "Daily discoveries",
  assistants: "Siri & assistants",
  chat: "Chat privacy",
  account: "Sign-in & account",
  about: "About Maple",
} as const;

type Page = keyof typeof PAGES;

function pageFromHash(): Page | null {
  const [tab, page] = window.location.hash.slice(1).split("/");
  return tab === "family" && page && Object.hasOwn(PAGES, page) ? page as Page : null;
}

export default function FamilyTab() {
  const { state, readOnly, auth, units } = useMaple();
  const medicalRecordsAvailable = useMedicalRecordsAvailable();
  const care = useCare();
  const nav = useCareNav();
  const [page, setPage] = useState<Page | null>(null);
  useSectionFocus("family", page);
  const [visited, setVisited] = useState<Page[]>([]);
  const fromIndex = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const dirty = Object.values(drafts).some(Boolean);
  const registerDraft = useCallback((id: string, changed: boolean) => {
    setDrafts((all) => all[id] === changed ? all : { ...all, [id]: changed });
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const beforeNavigate = (event: Event) => {
      if (!window.confirm("Leave Settings and discard your unsaved changes?")) event.preventDefault();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("maple-before-navigate", beforeNavigate);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("maple-before-navigate", beforeNavigate);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);

  useEffect(() => {
    const read = () => {
      const next = pageFromHash();
      setPage(next);
      if (next) setVisited((pages) => pages.includes(next) ? pages : [...pages, next]);
    };
    read();
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [page]);

  if (!state) return null;

  const photosOnly = state.me.role === "photos";
  const allowed = (target: Page) => {
    if (photosOnly) return ["people", "appearance", "account", "about"].includes(target);
    if (target === "medical-records") return state.me.role === "owner";
    if (target === "chat") return !!care?.self;
    return !readOnly || !["doctor", "today", "assistants"].includes(target);
  };
  const active = page && allowed(page) ? page : null;
  const open = (target: Page) => {
    fromIndex.current = true;
    window.location.assign(`#family/${target}`);
  };
  const back = () => {
    if (fromIndex.current) window.history.back();
    else window.location.assign("#family");
    fromIndex.current = false;
  };
  const row = (target: Page, icon: IconName, value?: string, note?: string) => allowed(target) && (
    <ActionRow key={target} icon={icon} label={PAGES[target]} value={value} note={note} chevron onClick={() => open(target)} />
  );
  const screens: Record<Page, ReactNode> = {
    people: <PeopleSettings />,
    baby: <BabySettings section="baby" />,
    doctor: <BabySettings section="doctor" />,
    "medical-records": <MedicalRecordsSettings key={`${state.family?.id ?? 1}:${state.me.email}:${state.baby.id}`} active={active === "medical-records"} />,
    today: <BabySettings section="today" />,
    appearance: <PhoneSettings />,
    discoveries: <DiscoveryPreferences />,
    assistants: <AssistantSettings />,
    chat: <Section title="What the chat can read"><div className={GROUP}><ChatCareRow /></div></Section>,
    account: <><SignInMethods memberId={state.me.email} /><DataAndAccount /></>,
    about: <About />,
  };
  const pageHeading = <h1 ref={heading} tabIndex={-1} className={cx(tone.display, "min-w-0 text-[34px] leading-[1.1] outline-none")}>{active ? PAGES[active] : "Settings"}</h1>;

  return (
    <SettingsDraftContext.Provider value={registerDraft}>
      <div className="space-y-6 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-8">
        <header className="space-y-2 px-1">
          <div className="flex min-h-[44px] items-center justify-between gap-3">
            {active
              ? <button type="button" onClick={back} className="-ml-2 flex min-h-[44px] items-center gap-1 rounded-xl px-2 text-[15px] font-semibold text-mp-accent-fg"><Icon name="chevron-left" size={18} />Settings</button>
              : pageHeading}
            <AccountMenu />
          </div>
          {active && pageHeading}
        </header>

        <div hidden={!!active} className="space-y-6">
          <Section title="Your account">
            <div className={GROUP}>
              {row("account", "key-round", undefined, photosOnly ? "Sign-in methods and family access" : "Sign-in methods and data export")}
              {row("assistants", "message-square", undefined, "Hands-free logging and connected apps")}
              {row("chat", "lock", undefined, "Access to your recovery page")}
            </div>
          </Section>
          <Section title="This device">
            <div className={GROUP}>
              {!photosOnly && <NotificationsRow />}
              {row("appearance", "sun", units === "metric" ? "Metric" : "US units")}
              {row("discoveries", "leaf", undefined, "Topics you enjoy and whether to show them")}
            </div>
          </Section>
          <Section title="Your family" action={<span className={cx(tone.faint, "text-[13px]")}>Shared settings</span>}>
            <div className={GROUP}>
              {row("baby", "baby", state.baby.nickname || state.baby.name)}
              {row("people", "users", `${state.members.length} ${state.members.length === 1 ? "person" : "people"}`)}
              {row("doctor", "stethoscope")}
              {medicalRecordsAvailable && row("medical-records", "download", "MyChart")}
              {row("today", "house", undefined, "Logging buttons and reminders")}
            </div>
          </Section>
          <div className={cx(tone.divide, "border-t border-mp-line")}>
            {!photosOnly && <ActionRow icon="life-buoy" label="Help and doctor numbers" chevron onClick={nav.openHelp} />}
            {row("about", "info", undefined, "Feedback, terms and privacy")}
            {auth?.metricsAdmin && <Link href="/maple/admin" className={cx(tone.row, "min-h-[52px]")}><Icon name="chart-column" size={20} className="text-mp-ink-2" /><span className="flex-1 text-[15px] text-mp-ink">Site metrics</span><Icon name="chevron-right" size={18} className="text-mp-ink-3" /></Link>}
          </div>
          {!photosOnly && <p className={cx(tone.faint, "px-4 text-center text-xs leading-relaxed")}>{DISCLAIMER}</p>}
        </div>

        {visited.filter(allowed).map((target) => <div key={target} hidden={active !== target} className="space-y-6">{screens[target]}</div>)}
      </div>
    </SettingsDraftContext.Provider>
  );
}
