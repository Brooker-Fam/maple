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

export async function captureServerException(
  error: unknown,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const ph = getPostHogServer();
  if (!ph) return;
  const err = error instanceof Error ? error : new Error(String(error));
  ph.captureException(err, "server", properties);
  await ph.flush().catch(() => {});
}
