import type { Metadata } from "next";
import SiteLayout from "./(site)/layout";
import SiteNotFound from "./(site)/not-found";

export const metadata: Metadata = {
  title: "Page not found | Maple",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <SiteLayout>
      <SiteNotFound />
    </SiteLayout>
  );
}
