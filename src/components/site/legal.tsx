import Link from "next/link";
import SiteFooter from "./SiteFooter";
import SiteHeader from "./SiteHeader";

export const LEGAL_UPDATED = "2026-10-26";
export const LEGAL_UPDATED_TEXT = "October 26, 2026";
export const LEGAL_VERSION = "1.2";
export const CONTACT_EMAIL = "hello@maplebaby.app";

export function LegalPage({
  title,
  lead,
  other,
  children,
}: {
  title: string;
  lead: string;
  other: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="font-display text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.01em] text-mp-ink sm:text-[3.5rem]">{title}</h1>
        <p className="mt-3 text-[15px] text-mp-ink-3">
          Version {LEGAL_VERSION}, updated <time dateTime={LEGAL_UPDATED}>{LEGAL_UPDATED_TEXT}</time>
        </p>
        <p className="mt-8 text-[19px] leading-[1.6] text-mp-ink-2">{lead}</p>
        <div className="site-legal mt-10">{children}</div>
        <p className="mt-14 border-t border-mp-line pt-6 text-[15px] text-mp-ink-2">
          Write to{" "}
          <a className="site-link" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          with any question about this page. See also the{" "}
          <Link className="site-link" href={other.href}>
            {other.label}
          </Link>
          .
        </p>
      </main>
      <SiteFooter />
    </>
  );
}

export function HelpLines() {
  return (
    <ul>
      <li>
        <strong>Emergency:</strong> call <a href="tel:911">911</a>, or go to the nearest emergency room.
      </li>
      <li>
        <strong>Suicide &amp; Crisis Lifeline:</strong> call or text <a href="tel:988">988</a>, any time.
      </li>
      <li>
        <strong>National Maternal Mental Health Hotline:</strong> call or text <a href="tel:18338526262">1-833-852-6262</a>, any time.
      </li>
    </ul>
  );
}
