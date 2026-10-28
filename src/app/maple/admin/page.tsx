import type { Metadata } from "next";
import AdminMetricsPage from "@/components/maple/admin/AdminMetricsPage";

export const metadata: Metadata = {
  title: "Admin | Maple",
  description: "Maple signups and activity.",
  robots: { index: false, follow: false },
};

// The session cookie is scoped to /api/maple. This page contains no metrics;
// the client asks the protected API after loading.
export default function Page() {
  return <AdminMetricsPage />;
}
