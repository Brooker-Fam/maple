"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminMetrics } from "@/lib/maple/admin/types";
import EmailSignIn from "../EmailSignIn";
import { Icon, type IconName } from "../icons";
import { Button, cx, tone } from "../ui";
import AdminDetails, { type DetailsSelection } from "./AdminDetails";
import type { AdminAuthProblem } from "./admin-request";
import { FeaturesSection, FeedbackSummary, LoggingSection, SourcesAndChat, Stat, TurnedOnSection } from "./AdminUsage";

type Problem = "signin" | "reauth" | "forbidden" | "unavailable";
const number = new Intl.NumberFormat("en-US");
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const updatedFormat = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
});
const dayLabel = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));
const linkClass = "inline-flex min-h-11 items-center gap-1.5 rounded-xl text-sm font-semibold text-mp-accent-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mp-focus";

export default function AdminMetricsPage() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setProblem(null);
    setMetrics(null);
    try {
      const response = await fetch("/api/maple/admin/metrics", {
        cache: "no-store", credentials: "same-origin", signal: current.signal,
      });
      if (current.signal.aborted) return;
      if (!response.ok) {
        const error = response.status === 403 ? await response.json().catch(() => null) as { code?: string } | null : null;
        if (current.signal.aborted) return;
        setMetrics(null);
        setProblem(response.status === 401 ? "signin" : response.status === 403 ? error?.code === "metrics_reauth" ? "reauth" : "forbidden" : "unavailable");
        return;
      }
      const data: AdminMetrics = await response.json();
      if (!current.signal.aborted) setMetrics(data);
    } catch {
      if (!current.signal.aborted) {
        setMetrics(null);
        setProblem("unavailable");
      }
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, []);

  const failAuth = useCallback((next: AdminAuthProblem) => {
    controller.current?.abort();
    setMetrics(null);
    setLoading(false);
    setProblem(next);
  }, []);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-8">
      <Link href="/maple" className={linkClass}>
        <Icon name="chevron-left" size={17} /> Back to Maple
      </Link>
      <header className="mt-7 mb-7 flex flex-wrap items-end justify-between gap-5 sm:mt-10">
        <div>
          <p className="mb-2 text-sm font-medium text-mp-accent-fg">Maple admin</p>
          <h1 className={cx(tone.display, "text-4xl leading-tight sm:text-5xl")}>Signups and activity</h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-mp-ink-2">Signups, setup, what families use and what they think of Maple.</p>
        </div>
        <Button variant="soft" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh-cw" size={17} /> {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      <div role="status" className="sr-only">{loading ? "Loading metrics" : metrics ? "Metrics updated" : ""}</div>
      {problem ? <ProblemCard problem={problem} retry={() => void load()} /> : metrics ? <Overview metrics={metrics} onAuthProblem={failAuth} /> : <LoadingCards />}
    </main>
  );
}

function ProblemCard({ problem, retry }: { problem: Problem; retry: () => void }) {
  const copy = {
    signin: { title: "Sign in to see Maple’s metrics", body: "Sign in with your admin account to continue." },
    reauth: { title: "Verify your admin account", body: "Sign in directly with your admin account to see Maple’s metrics. Verification lasts 12 hours." },
    forbidden: { title: "This page is for Maple’s admin", body: "Your current account doesn’t have access. Open Maple to switch accounts, then try again." },
    unavailable: { title: "The numbers couldn’t load", body: "Maple couldn’t get a fresh snapshot. Check your connection and try again in a moment." },
  }[problem];
  return (
    <section role="alert" className={cx(tone.card, "mx-auto max-w-xl px-6 py-10 text-center sm:mt-16")}>
      <Icon name={problem === "unavailable" ? "cloud-off" : "lock"} size={28} className="mx-auto mb-4 text-mp-ink-2" />
      <h2 className={cx(tone.heading, "text-xl")}>{copy.title}</h2>
      <p className="mt-3 text-[15px] leading-relaxed text-mp-ink-2">{copy.body}</p>
      {problem === "reauth" && <div className="mx-auto mt-6 max-w-sm space-y-3">
        <VerifyGoogleLink />
        <EmailSignIn startFields={() => ({ return: "/maple/admin" })} label="Verify with email" />
      </div>}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
        {problem !== "unavailable" && problem !== "reauth" && <Link href={problem === "signin" ? "/maple?return=%2Fmaple%2Fadmin" : "/maple"} className={linkClass}>{problem === "signin" ? "Sign in to Maple" : "Open Maple"}<Icon name="arrow-right" size={16} /></Link>}
        <Button variant="soft" onClick={retry}>{problem === "unavailable" ? "Try again" : "Check again"}</Button>
      </div>
    </section>
  );
}

function VerifyGoogleLink() {
  return (
    // OAuth needs a full-page navigation to set its state cookie.
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    <a href="/api/maple/auth/start?return=%2Fmaple%2Fadmin" onClick={(event) => {
      event.preventDefault();
      window.location.assign(`/api/maple/auth/start?return=%2Fmaple%2Fadmin&site=${encodeURIComponent(window.location.origin)}`);
    }} className="flex min-h-[52px] items-center justify-center rounded-[14px] bg-mp-accent px-5 text-base font-semibold text-mp-on-accent hover:opacity-90">Verify with Google</a>
  );
}

function LoadingCards() {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => <div key={i} className={cx(tone.card, "h-44 p-5")}>
        <div className="h-3 w-20 rounded bg-mp-sunken" /><div className="mt-5 h-9 w-14 rounded bg-mp-sunken" /><div className="mt-5 h-3 w-28 max-w-full rounded bg-mp-sunken" />
      </div>)}
    </div>
  );
}

function MetricCard({ label, value, note, icon, emphasis, onClick, actionLabel }: { label: string; value: number; note: string; icon: IconName; emphasis?: boolean; onClick: () => void; actionLabel: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={actionLabel} className={cx(emphasis ? "rounded-[20px] border border-mp-accent bg-mp-accent text-mp-on-accent" : tone.card, "group flex flex-col p-4 text-left transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mp-focus sm:p-5")}>
      <span className={cx("flex w-full items-center justify-between gap-2 text-sm font-medium", !emphasis && "text-mp-ink-2")}>
        {label}
        <Icon name={icon} size={18} className={emphasis ? "opacity-75" : "text-mp-accent-fg"} />
      </span>
      <span>
        <span className="mt-4 block text-4xl font-semibold tracking-tight tabular-nums sm:text-[44px]">{number.format(value)}</span>
        <span className={cx("mt-3 block text-xs leading-relaxed", emphasis ? "opacity-85" : "text-mp-ink-3")}>{note}</span>
      </span>
      <span className={cx("mt-3 flex items-center gap-1 text-xs font-semibold", !emphasis && "text-mp-accent-fg")}>View details <Icon name="arrow-right" size={13} /></span>
    </button>
  );
}

function Overview({ metrics: m, onAuthProblem }: { metrics: AdminMetrics; onAuthProblem: (problem: AdminAuthProblem) => void }) {
  const [selection, setSelection] = useState<DetailsSelection | null>(null);
  const showDetails = (next: DetailsSelection) => {
    setSelection(next);
    document.getElementById("admin-details-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const completion = m.families.total ? Math.round(m.families.setupComplete / m.families.total * 100) : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" aria-label="Browse accounts and waitlist">
        <MetricCard label="Families" value={m.families.total} note="Current family accounts" icon="house" emphasis actionLabel="View families" onClick={() => showDetails({ view: "families", filter: "all" })} />
        <MetricCard label="People" value={m.people.total} note="People with accepted accounts" icon="users" actionLabel="View people" onClick={() => showDetails({ view: "people", filter: "all" })} />
        <MetricCard label="New this week" value={m.families.signedUp7d} note="Family signups in the last 7 days" icon="sprout" actionLabel="View new families in 7 days" onClick={() => showDetails({ view: "families", filter: "7d" })} />
        <MetricCard label="Waitlist" value={m.waitlist.total} note="Email signups to the waitlist" icon="list" actionLabel="View waitlist" onClick={() => showDetails({ view: "waitlist", filter: "all" })} />
      </div>

      <p className="px-1 text-xs leading-relaxed text-mp-ink-3">Family, people and usage counts exclude the original family; feedback includes it. Updated {updatedFormat.format(new Date(m.generatedAt))}.</p>

      <FeedbackSummary metrics={m} onSelect={showDetails} />

      {selection && <AdminDetails key={`${selection.view}/${selection.filter}`} selection={selection} onSelect={showDetails} onClose={() => setSelection(null)} onAuthProblem={onAuthProblem} />}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <SignupChart days={m.dailySignups} rollingTotal={m.families.signedUp30d} onViewSignups={() => showDetails({ view: "families", filter: "30d" })} />
        <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="setup-title">
          <h2 id="setup-title" className={cx(tone.heading, "text-lg")}>Getting settled</h2>
          <p className="mt-1 text-sm text-mp-ink-2">How many families finished setup.</p>
          <p className="mt-6 text-4xl font-semibold tracking-tight tabular-nums">{m.families.total ? `${completion}%` : "—"}</p>
          <p className="mt-2 text-sm text-mp-ink-2">{number.format(m.families.setupComplete)} of {number.format(m.families.total)} families set up</p>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-mp-sunken" aria-hidden="true"><div className="h-full rounded-full bg-mp-accent" style={{ width: `${completion}%` }} /></div>
          <div className="mt-6 divide-y divide-mp-line">
            <CountRow label="Setup complete" value={m.families.setupComplete} onClick={() => showDetails({ view: "families", filter: "setup_complete" })} />
            <CountRow label="Still setting up" value={m.families.onboarding} onClick={() => showDetails({ view: "families", filter: "onboarding" })} />
            <CountRow label="Deletion requested" value={m.families.deleting} onClick={() => showDetails({ view: "families", filter: "deleting" })} />
          </div>
        </section>
      </div>

      <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="activity-title">
        <h2 id="activity-title" className={cx(tone.heading, "text-lg")}>Coming back to Maple</h2>
        <p className="mt-1 text-sm text-mp-ink-2">A family counts once when someone opens its log.</p>
        <div className="mt-5 grid gap-6 sm:grid-cols-3 sm:gap-4">
          <Stat label="Families active in 7 days" value={m.activity.families7d} onClick={() => showDetails({ view: "families", filter: "active7d" })} />
          <Stat label="Families active in 30 days" value={m.activity.families30d} onClick={() => showDetails({ view: "families", filter: "active30d" })} />
          <Stat label="Entries added in 30 days" value={m.activity.entries30d} />
        </div>
      </section>

      <LoggingSection metrics={m} onSelect={showDetails} />
      <FeaturesSection metrics={m} onSelect={showDetails} />
      <SourcesAndChat metrics={m} onSelect={showDetails} />
      <TurnedOnSection metrics={m} />

      <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="numbers-title">
        <h2 id="numbers-title" className={cx(tone.heading, "text-lg")}>About these numbers</h2>
        <div className="mt-3 grid gap-5 text-sm leading-relaxed text-mp-ink-2 sm:grid-cols-2">
          <p>Signups count families. People counts each accepted account once, even if it belongs to more than one family. Pending invitations and guests using an invite link aren’t included in that total.</p>
          <p>These are current totals, so deleted accounts are no longer included. Activity covers log opens and saved entries; deleted entries are excluded. The chart uses UTC calendar dates; other 7 and 30 day totals use the time of this snapshot.</p>
          <p>Usage counts entries by when they were saved, grouped by kind and by where they came from, never what they say. Logging days are 24-hour periods counted back from this snapshot. Chat counts come from a daily tally that stays when someone deletes their chat history.</p>
          <p>Feedback shows every message saved from every family, the original family included, in full, with the sender&rsquo;s address hidden until you reveal it. The question on Today goes to owners and members of set-up families once they have used Maple for a few days, and at most twice.</p>
        </div>
        <div className="mt-5 border-t border-mp-line pt-4 sm:flex sm:items-center sm:justify-between sm:gap-6">
          <p className="max-w-2xl text-sm leading-relaxed text-mp-ink-2">PostHog has separate event trends, including site visits, signup conversion and app opens. Its sign-in and project access are managed there.</p>
          <a href="https://us.posthog.com" target="_blank" rel="noopener noreferrer" className={cx(linkClass, "mt-2 shrink-0 sm:mt-0")}>
            Open PostHog <Icon name="arrow-right" size={16} /><span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </section>
    </div>
  );
}

function CountRow({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex min-h-12 w-full items-center justify-between gap-4 rounded-lg py-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-mp-focus"><span className="text-mp-ink-2">{label}</span><span className="flex items-center gap-2 font-semibold tabular-nums">{number.format(value)}<Icon name="chevron-right" size={14} className="text-mp-ink-3" /></span></button>;
}

function SignupChart({ days, rollingTotal, onViewSignups }: { days: AdminMetrics["dailySignups"]; rollingTotal: number; onViewSignups: () => void }) {
  const max = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((n, day) => n + day.count, 0);
  return (
    <section className={cx(tone.card, "min-w-0 p-5 sm:p-6")} aria-labelledby="signups-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 id="signups-title" className={cx(tone.heading, "text-lg")}>New families</h2><p className="mt-1 text-sm text-mp-ink-2">Daily signups · last 30 calendar days</p></div>
        <button type="button" onClick={onViewSignups} aria-label="View new families in 30 days" className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-mp-sunken px-3 py-1.5 text-xs font-medium text-mp-accent-fg focus-visible:outline-2 focus-visible:outline-mp-focus">{number.format(rollingTotal)} in the last 30 days<Icon name="chevron-right" size={13} /></button>
      </div>
      <div className="mt-6" role="img" aria-label={`${number.format(total)} new families across the displayed dates. Daily counts are available in the table below.`}>
        <div aria-hidden="true" className="mb-2 text-right text-xs tabular-nums text-mp-ink-3">{number.format(max)}</div>
        <div className="relative flex h-36 items-end gap-1 border-y border-mp-line sm:h-44" aria-hidden="true">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-mp-line" />
          {days.map((day) => <div key={day.date} className="relative flex h-full min-w-0 flex-1 items-end" title={`${dayLabel(day.date)}: ${number.format(day.count)}`}>
            <div className={cx("w-full rounded-t-sm", day.count ? "bg-mp-accent" : "bg-mp-line")} style={{ height: day.count ? `${day.count / max * 100}%` : "2px" }} />
          </div>)}
        </div>
        <div aria-hidden="true" className="mt-2 flex justify-between gap-3 text-xs text-mp-ink-3"><span>{days[0] ? dayLabel(days[0].date) : ""}</span><span>Today (UTC)</span></div>
      </div>
      {total === 0 && <p className="mt-4 text-sm text-mp-ink-2">No new families in these dates yet.</p>}
      <details className="mt-4 border-t border-mp-line pt-2">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-mp-accent-fg">View daily counts</summary>
        <div className="max-h-64 overflow-auto rounded-xl border border-mp-line">
          <table className="w-full text-sm">
            <caption className="sr-only">Daily new family signups in UTC</caption>
            <thead className="sticky top-0 bg-mp-surface text-mp-ink-2"><tr><th scope="col" className="px-4 py-3 text-left font-medium">Date (UTC)</th><th scope="col" className="px-4 py-3 text-right font-medium">New families</th></tr></thead>
            <tbody className="divide-y divide-mp-line">{[...days].reverse().map((day) => <tr key={day.date}><th scope="row" className="px-4 py-2.5 text-left font-normal"><time dateTime={day.date}>{day.date}</time></th><td className="px-4 py-2.5 text-right tabular-nums">{number.format(day.count)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
