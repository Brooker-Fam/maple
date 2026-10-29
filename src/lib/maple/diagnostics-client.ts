"use client";

import { MAX_DIAGNOSTIC_EVENTS, syncDiagnostic, syncRequestId, type SyncDiagnostic, type SyncDiagnosticDetails, type SyncEvent } from "./diagnostics";

const MAX_EVENTS_PER_MINUTE = 30;
const queue: SyncDiagnostic[] = [];
let scheduled: ReturnType<typeof setTimeout> | undefined;
let sending = false;
let windowStart = 0;
let count = 0;

export function newSyncRequestId(): string | undefined {
  try {
    return syncRequestId(globalThis.crypto.randomUUID());
  } catch {
    return undefined;
  }
}

export function recordSyncDiagnostic(event: SyncEvent, details: SyncDiagnosticDetails = {}): void {
  try {
    if (typeof window === "undefined") return;
    const diagnostic = syncDiagnostic(event, details);
    if (!diagnostic || queue.length >= MAX_DIAGNOSTIC_EVENTS) return;
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      count = 0;
    }
    if (count >= MAX_EVENTS_PER_MINUTE) return;
    count++;
    queue.push(diagnostic);
    schedule();
  } catch {}
}

function schedule() {
  if (!sending && scheduled === undefined) scheduled = setTimeout(() => { void flush(); }, 250);
}

async function flush() {
  scheduled = undefined;
  if (sending || !queue.length) return;
  const events = queue.splice(0, MAX_DIAGNOSTIC_EVENTS);
  sending = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 4000);
    await fetch("/api/maple/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      credentials: "same-origin",
      mode: "same-origin",
      referrerPolicy: "strict-origin",
      cache: "no-store",
      redirect: "error",
      keepalive: true,
      signal: controller.signal,
    });
  } catch {
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    sending = false;
    if (queue.length) schedule();
  }
}
