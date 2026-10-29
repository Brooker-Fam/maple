import Link from "next/link";
import GetStarted from "./GetStarted";
import { SIGN_IN_PATH } from "./paths";
import Leaf from "./Leaf";
import { CONTACT_EMAIL } from "./legal";

export default function SiteFooter() {
  return (
    <footer className="border-t border-mp-line">
      <div className="mx-auto grid w-full max-w-[76rem] gap-8 px-4 py-12 sm:grid-cols-[1fr_auto] sm:px-8">
        <div className="max-w-[34rem]">
          <p className="flex items-center gap-2">
            <Leaf size={22} />
            <span className="font-display text-xl font-semibold text-mp-ink">Maple</span>
          </p>
          <p className="mt-4 text-[15px] leading-relaxed text-mp-ink-2">
            Maple is a tracker and doesn&rsquo;t give medical advice. If you think your baby or you need help now, call{" "}
            <a className="site-link" href="tel:911">
              911
            </a>
            .
          </p>
        </div>
        <nav aria-label="Site" className="flex max-w-[30rem] flex-wrap content-start gap-x-6 gap-y-3 text-[15px] text-mp-ink-2">
          <Link className="site-link-quiet" href="/about">
            Our story
          </Link>
          <Link className="site-link-quiet" href="/faq">
            FAQ
          </Link>
          <Link className="site-link-quiet" href="/pricing">
            Pricing
          </Link>
          <Link className="site-link-quiet" href="/blog">
            Blog
          </Link>
          <Link className="site-link-quiet" href="/privacy">
            Privacy
          </Link>
          <Link className="site-link-quiet" href="/terms">
            Terms
          </Link>
          <a className="site-link-quiet" href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Maple feedback")}`}>
            Send feedback
          </a>
          <a className="site-link-quiet" href="https://github.com/Brooker-Fam/maple">
            Source code
          </a>
          <a className="site-link-quiet" href={SIGN_IN_PATH} rel="nofollow">
            Sign in
          </a>
          <GetStarted size="text" className="site-link-quiet" placement="footer" />
        </nav>
      </div>
    </footer>
  );
}
