export type AdminAuthProblem = "signin" | "reauth" | "forbidden";

export class AdminRequestError extends Error {
  constructor(public status: number, public code?: string) {
    super("admin_request_failed");
  }
}

export function authProblem(error: unknown): AdminAuthProblem | null {
  if (!(error instanceof AdminRequestError)) return null;
  if (error.status === 401) return "signin";
  if (error.status === 403) return error.code === "metrics_reauth" ? "reauth" : "forbidden";
  return null;
}

/** Private responses stay in component memory; references travel only in POST bodies. */
export async function adminRequest<T>(path: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new AdminRequestError(response.status, typeof data?.code === "string" ? data.code : undefined);
  if (data === null) throw new AdminRequestError(502);
  return data as T;
}
