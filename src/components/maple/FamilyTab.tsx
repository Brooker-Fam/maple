"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DISCLAIMER } from "@/lib/maple/guidelines";
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
import { SettingsDraftContext } from "./settings/DraftContext";
import { ActionRow, GROUP, Section } from "./settings/parts";
import { useSectionFocus } from "./sectionFocus";
import { cx, tone } from "./ui";
import { useMaple } from "./useMaple";

const PAGES = {
  people: "People & permissions",
  baby: "Baby details",
  doctor: "Doctor & care plan",
  today: "On Today",
  appearance: "Appearance & units",
  assistants: "Shortcuts & assistants",
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
  const { state, readOnly, auth } = useMaple();
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

  const allowed = (target: Page) => {
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
  const row = (target: Page, icon: IconName, note?: string) => allowed(target) && (
    <ActionRow key={target} icon={icon} label={PAGES[target]} note={note} chevron onClick={() => open(target)} />
  );
  const screens: Record<Page, ReactNode> = {
    people: <PeopleSettings />,
    baby: <BabySettings section="baby" />,
    doctor: <BabySettings section="doctor" />,
    today: <BabySettings section="today" />,
    appearance: <PhoneSettings />,
    assistants: <AssistantSettings />,
    chat: <Section title="What the chat can read"><div className={GROUP}><ChatCareRow /></div></Section>,
    account: <><SignInMethods memberId={state.me.email} /><DataAndAccount /></>,
    about: <About />,
  };

  return (
    <SettingsDraftContext.Provider value={registerDraft}>
      <div className="space-y-6 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-8">
        <header className="px-1">
          {active && <button type="button" onClick={back} className="-ml-2 mb-2 flex min-h-[44px] items-center gap-1 rounded-xl px-2 text-[15px] font-semibold text-mp-accent-fg"><Icon name="chevron-left" size={18} />Settings</button>}
          <h1 ref={heading} tabIndex={-1} className={cx(tone.display, "flex min-h-[44px] items-center text-[34px] leading-[1.05] outline-none")}>{active ? PAGES[active] : "Settings"}</h1>
        </header>

        <div hidden={!!active} className="space-y-6">
          <Section title="Family">
            <div className={GROUP}>
              {row("people", "users", "Who's in the log and what they can see")}
              {row("baby", "baby", "Name, birth details and growth charts")}
              {row("doctor", "stethoscope", "Phone numbers and your pediatrician's plan")}
              {row("today", "house", "Logging buttons, warnings and reminders")}
            </div>
          </Section>
          <Section title="This phone">
            <div className={GROUP}>
              <NotificationsRow />
              {row("appearance", "sun", "Theme, night look and measurement units")}
            </div>
          </Section>
          <Section title="Account & help">
            <div className={GROUP}>
              {row("account", "key-round", "Sign-in methods, download and sign out")}
              {row("assistants", "message-square", "Claude, ChatGPT and Siri")}
              {row("chat", "lock", "Let the chat read your recovery page")}
              <ActionRow icon="life-buoy" label="Help and doctor numbers" note="Warning signs, call buttons and support" chevron onClick={nav.openHelp} />
              {row("about", "info", "Feedback, terms and privacy")}
            </div>
          </Section>
          {auth?.metricsAdmin && <Section title="Administration"><Link href="/maple/admin" className={cx(GROUP, tone.row, "min-h-[60px] text-mp-accent-fg")}><Icon name="chart-column" size={20} /><span className="flex-1 text-[15px] font-medium">Site metrics</span><Icon name="chevron-right" size={18} /></Link></Section>}
          <p className={cx(tone.faint, "px-4 text-center text-xs leading-relaxed")}>{DISCLAIMER}</p>
        </div>

        {visited.filter(allowed).map((target) => <div key={target} hidden={active !== target} className="space-y-6">{screens[target]}</div>)}
      </div>
    </SettingsDraftContext.Provider>
  );
}
