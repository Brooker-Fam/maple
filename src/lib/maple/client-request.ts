import { deviceHeaders } from "./device";
import { newSyncRequestId, recordSyncDiagnostic } from "./diagnostics-client";
import { FAMILY_MOVED_EVENT, shownFamilyHeaders } from "@/components/maple/shownFamily";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

type RefreshRequest = { sequence: number; generation: number; sentAt: number; requestId?: string };

export function createMapleRequests() {
  let generation = 0;
  let writes = 0;
  let sequence = 0;
  let accepted = 0;
  let afterWrite: string | undefined;
  let refreshFailed = false;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const write = (init?.method ?? "GET").toUpperCase() !== "GET";
    const url = path.startsWith("/") ? path : `/api/maple/${path}`;
    const tracked = write && /^\/api\/maple\/(?:timer|entries)(?:[/?]|$)/.test(url);
    const requestId = tracked ? newSyncRequestId() : undefined;
    const started = Date.now();
    const headers = new Headers({ "Content-Type": "application/json", ...deviceHeaders(), ...(write ? shownFamilyHeaders() : {}) });
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (requestId) headers.set("x-maple-request-id", requestId);
    if (write) {
      generation++;
      writes++;
    }
    try {
      const res = await fetch(url, { ...init, headers, cache: "no-store" });
      const body: unknown = await res.json().catch(() => null);
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
      throw error;
    } finally {
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
