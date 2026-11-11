import { deviceHeaders } from "./device";
import { newSyncRequestId, recordSyncDiagnostic } from "./diagnostics-client";
import { FAMILY_MOVED_EVENT, shownFamilyHeaders } from "@/components/maple/shownFamily";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

/**
 * How long a write waits for its answer. A request whose connection died
 * quietly (a phone locked or switching networks mid-save) can stay pending
 * with no error, and while any write is out the polls don't read (a read
 * from before it lands could undo it on screen), so without a deadline one
 * lost request kept a phone on an old log until someone reloaded the page.
 * Every Maple write is quick; a call that can take longer passes `timeoutMs`.
 */
export const WRITE_TIMEOUT_MS = 30_000;

/** A write that got no answer in time: it may or may not have reached the server. */
export class RequestTimeout extends Error {
  constructor() {
    super("Maple didn't answer, so this may not have saved. Check the log before trying again.");
    this.name = "RequestTimeout";
  }
}

/** `timeoutMs`: how long this call may wait for its answer (writes default to WRITE_TIMEOUT_MS; reads, no limit). */
export type MapleRequestInit = RequestInit & { timeoutMs?: number };

type RefreshRequest = { sequence: number; generation: number; sentAt: number; requestId?: string };

export function createMapleRequests() {
  let generation = 0;
  let writes = 0;
  let sequence = 0;
  let accepted = 0;
  let afterWrite: string | undefined;
  let refreshFailed = false;

  async function request<T>(path: string, options?: MapleRequestInit): Promise<T> {
    const { timeoutMs, ...init } = options ?? {};
    const write = (init.method ?? "GET").toUpperCase() !== "GET";
    const url = path.startsWith("/") ? path : `/api/maple/${path}`;
    const tracked = write && /^\/api\/maple\/(?:timer|entries)(?:[/?]|$)/.test(url);
    const requestId = tracked ? newSyncRequestId() : undefined;
    const started = Date.now();
    const headers = new Headers({ "Content-Type": "application/json", ...deviceHeaders(), ...(write ? shownFamilyHeaders() : {}) });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (requestId) headers.set("x-maple-request-id", requestId);
    if (write) {
      generation++;
      writes++;
    }
    // The deadline aborts the request; the caller's own signal still can (AbortSignal.any isn't on every phone).
    const limit = timeoutMs ?? (write ? WRITE_TIMEOUT_MS : undefined);
    const deadline = limit ? new AbortController() : null;
    let timedOut = false;
    const timer = deadline ? setTimeout(() => { timedOut = true; deadline.abort(); }, limit) : undefined;
    const callerAbort = () => deadline?.abort();
    if (deadline && init.signal) {
      if (init.signal.aborted) deadline.abort();
      else init.signal.addEventListener("abort", callerAbort, { once: true });
    }
    try {
      const res = await fetch(url, { ...init, headers, cache: "no-store", signal: deadline?.signal ?? init.signal });
      const body: unknown = await res.json().catch(() => null);
      // Cut off while the answer was still arriving: no answer, not an empty one.
      if (timedOut) throw new RequestTimeout();
      if (!res.ok) {
        const error = new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status, body);
        if (res.status === 409 && (body as { code?: string } | null)?.code === "family_mismatch") window.dispatchEvent(new Event(FAMILY_MOVED_EVENT));
        throw error;
      }
      if (tracked) {
        recordSyncDiagnostic("write_succeeded", { requestId, status: res.status, elapsedMs: Date.now() - started });
        afterWrite = requestId;
      }
      return body as T;
    } catch (error) {
      if (tracked) recordSyncDiagnostic("write_failed", { requestId, status: error instanceof ApiError ? error.status : 0, elapsedMs: Date.now() - started });
      throw timedOut ? new RequestTimeout() : error;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", callerAbort);
      if (write) {
        writes--;
        generation++;
      }
    }
  }

  return {
    request,
    beginRefresh(): RefreshRequest | null {
      if (writes) return null;
      return { sequence: ++sequence, generation, sentAt: Date.now(), requestId: afterWrite ?? (refreshFailed ? newSyncRequestId() : undefined) };
    },
    acceptRefresh(read: RefreshRequest): boolean {
      if (writes || read.generation !== generation || read.sequence < accepted) {
        recordSyncDiagnostic("stale_response_discarded", { requestId: read.requestId, elapsedMs: Date.now() - read.sentAt });
        return false;
      }
      accepted = read.sequence;
      return true;
    },
    refreshed(read: RefreshRequest): void {
      if (afterWrite && read.requestId === afterWrite) {
        recordSyncDiagnostic("refresh_applied_after_write", { requestId: afterWrite, elapsedMs: Date.now() - read.sentAt });
        afterWrite = undefined;
      }
      if (refreshFailed) recordSyncDiagnostic("refresh_recovered", { requestId: read.requestId, elapsedMs: Date.now() - read.sentAt });
      refreshFailed = false;
    },
    refreshFailed(read: RefreshRequest, error: unknown): void {
      recordSyncDiagnostic("refresh_failed", { requestId: read.requestId, status: error instanceof ApiError ? error.status : 0, elapsedMs: Date.now() - read.sentAt });
      refreshFailed = true;
    },
  };
}
