"use client";

import { useCallback, useEffect, useState } from "react";
import { isNativeApp } from "@/lib/maple/native";
import EmailSignIn from "./EmailSignIn";
import AppleMark from "./AppleMark";
import { Button, SectionTitle, cx, tone } from "./ui";

type Methods = { apple: boolean; email: boolean; methods: { provider: "apple" | "email"; label: string }[] };

/** Connect another verified identity while signed in, so it opens the same existing family log. */
export default function SignInMethods({ memberId }: { memberId: string }) {
  const [methods, setMethods] = useState<Methods | null>(null);
  const [error, setError] = useState(false);
  const [site, setSite] = useState("");
  const [native, setNative] = useState(false);
  const eligible = memberId.includes("@") && !memberId.startsWith("invite:");
  const load = useCallback(async () => {
    if (!eligible) return;
    setError(false);
    try {
      const response = await fetch("/api/maple/auth/methods", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      setMethods(await response.json() as Methods);
    } catch {
      setError(true);
    }
  }, [eligible]);

  useEffect(() => {
    setSite(window.location.origin);
    setNative(isNativeApp());
    void load();
  }, [load]);

  if (!eligible || (!error && methods && !methods.apple && !methods.email && !methods.methods.length)) return null;
  const appleLinked = methods?.methods.some((method) => method.provider === "apple");

  return (
    <section>
      <SectionTitle>Sign-in methods</SectionTitle>
      <div className={cx(tone.card, "space-y-4 p-4")}>
        <p className={cx(tone.muted, "text-sm leading-relaxed")}>Connect another way to sign in to this same account. Your family&apos;s log and history stay together.</p>
        {error ? (
          <div>
            <p role="alert" className="text-sm text-mp-danger">Couldn&apos;t load your sign-in methods.</p>
            <Button variant="ghost" onClick={() => void load()}>Try again</Button>
          </div>
        ) : !methods ? <p role="status" className={cx(tone.muted, "text-sm")}>Loading sign-in methods…</p> : (
          <>
            {methods.methods.length > 0 && <ul className="space-y-2 text-sm text-mp-ink" aria-label="Connected sign-in methods">
              {methods.methods.map((method) => <li key={`${method.provider}:${method.label}`} className="break-words"><span className="font-medium">{method.provider === "apple" ? "Apple" : "Email"}</span> · {method.label}</li>)}
            </ul>}
            {methods.email && <EmailSignIn mode="link" label="Connect another email address" />}
            {methods.apple && !appleLinked && (native ? (
              <p className={cx(tone.muted, "text-sm leading-relaxed")}>To connect Apple, open Maple in your browser, sign in, then go to Family → Sign-in methods. Once connected, you can use Apple to sign in here too.</p>
            ) : (
              <form action="/api/maple/auth/apple/start" method="post">
                <input type="hidden" name="mode" value="link" />
                <input type="hidden" name="site" value={site} />
                <button type="submit" className="flex min-h-[52px] w-full items-center justify-center gap-3 rounded-[14px] bg-mp-ink px-5 text-base font-semibold text-mp-bg transition hover:opacity-90"><AppleMark />Connect Apple</button>
                <p className={cx(tone.faint, "mt-2 text-[13px] leading-relaxed")}>Apple&apos;s Hide My Email works too. Connecting it here keeps your existing log.</p>
              </form>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
