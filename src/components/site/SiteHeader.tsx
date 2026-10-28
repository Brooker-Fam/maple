import Link from "next/link";
import GetStarted from "./GetStarted";
import { SIGN_IN_PATH } from "./paths";
import Leaf from "./Leaf";

const LINKS = [
  { href: "/faq", label: "FAQ" },
  { href: "/pricing", label: "Pricing" },
  { href: "/blog", label: "Blog" },
];

export default function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-[76rem] flex-wrap items-center justify-between gap-y-1 px-4 pt-5 sm:flex-nowrap sm:gap-x-2 sm:px-8 sm:pt-7">
      <a href="#main" className="site-skip">
        Skip to content
      </a>
      <Link href="/" className="site-focus -m-2 flex items-center gap-2.5 rounded-xl p-2" aria-label="Maple, home">
        <Leaf size={30} />
        <span className="font-display text-[1.7rem] leading-none font-semibold tracking-[-0.01em] text-mp-ink">Maple</span>
      </Link>
      <nav aria-label="Main" className="order-last -ml-3 flex w-full items-center sm:order-none sm:ml-auto sm:w-auto">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="site-focus rounded-xl px-3 py-2.5 text-[15px] text-mp-ink-2 hover:text-mp-ink">
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="flex items-center gap-1 sm:ml-2">
        <a href={SIGN_IN_PATH} rel="nofollow" className="site-focus rounded-xl px-3 py-2.5 text-[15px] font-medium whitespace-nowrap text-mp-ink hover:underline hover:underline-offset-4">
          Sign in
        </a>
        <GetStarted size="small" placement="header" />
      </div>
    </header>
  );
}
