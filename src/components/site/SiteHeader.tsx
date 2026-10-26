import Link from "next/link";
import Leaf from "./Leaf";

export default function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-[76rem] items-center justify-between px-4 pt-5 sm:px-8 sm:pt-7">
      <a href="#main" className="site-skip">
        Skip to content
      </a>
      <Link href="/" className="site-focus -m-2 flex items-center gap-2.5 rounded-xl p-2" aria-label="Maple, home">
        <Leaf size={30} />
        <span className="font-display text-[1.7rem] leading-none font-semibold tracking-[-0.01em] text-mp-ink">Maple</span>
      </Link>
      <a href="/maple" rel="nofollow" className="site-focus -mr-2 rounded-xl px-3 py-2.5 text-[15px] text-mp-ink-2 hover:text-mp-ink">
        Sign in
      </a>
    </header>
  );
}
