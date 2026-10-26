import { PostHog } from "posthog-node";

let client: PostHog | null = null;

export function getPostHogServer(): PostHog | null {
  if (client) return client;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  client = new PostHog(key, {
    host: "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
  return client;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,60}$/;

/**
 * An error's class, code and stack frames, never its message: Postgres quotes
 * the row it was writing ("Failing row contains (…)") and JSON.parse quotes its
 * input. A message that is already a bare token ("care_error") is kept.
 */
export function scrubError(error: unknown): Error {
  const e = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown } | null;
  const token = (v: unknown) => (typeof v === "string" && TOKEN.test(v) ? v : null);
  const label = token(e?.message) ?? [token(e?.name) ?? "Error", token(e?.code)].filter(Boolean).join(" ");
  const scrubbed = new Error(label);
  const frames = typeof e?.stack === "string" ? e.stack.split("\n").filter((line) => /^\s+at /.test(line)) : [];
  scrubbed.stack = [`Error: ${label}`, ...frames].join("\n");
  return scrubbed;
}

export async function captureServerException(
  error: unknown,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const ph = getPostHogServer();
  if (!ph) return;
  ph.captureException(scrubError(error), "server", properties);
  await ph.flush().catch(() => {});
}
