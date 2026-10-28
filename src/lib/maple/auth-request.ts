/** Reject sibling-site posts as well as cross-site posts. Origin is authoritative when supplied. */
export function sameOriginRequest(req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}
