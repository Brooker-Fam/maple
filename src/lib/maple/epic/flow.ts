import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { json, withMember } from "../api";
import { sessionContext, SESSION_COOKIE } from "../auth";
import type { FamilyCtx } from "../family";
import { allowAttempt } from "../family/limits";
import { getBaby } from "../store";
import { dayKey } from "../time";
import { MAPLE_ORIGIN } from "../origin";
import { NATIVE_UA_TOKEN } from "../native";
import { epicConfig, REVIEW_TTL_MS, type EpicConfig } from "./config";
import { hash, randomToken, seal, unseal } from "./crypto";
import { authorizationUrl, exchangeCode } from "./oauth";
import { fetchGrowth, fetchPatient, FhirReadError, type FhirPatient, type GrowthMeasurement } from "./fhir";
import * as store from "./store";

const BROWSER_COOKIE = "maple_epic_browser";
const CALLBACK_PATH = "/api/maple/epic/callback";
const RETURN_PATH = "/maple#family/medical-records";
type Attempt = { verifier: string; fingerprint: string; babyId: number; expiresAt: string };
type Preview = {
  fingerprint: string; accessToken: string; patient: FhirPatient;
  stage: "patient" | "measurements"; measurements?: GrowthMeasurement[]; skipped?: number;
};
const fingerprint = (c: EpicConfig) => hash(JSON.stringify([c.provider.id, c.clientId, c.redirectUri]));
const browserHash = (request: NextRequest, browser: string) => hash(JSON.stringify([browser, request.cookies.get(SESSION_COOKIE)?.value ?? ""]));

class FlowError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
function expired(): never { throw new FlowError("expired", 409, "That review has expired. Connect to MyChart again."); }
function requireConfig(): EpicConfig {
  const config = epicConfig();
  if (!config) throw new FlowError("disabled", 503, "Medical record imports aren't available right now.");
  return config;
}

/** Require a browser-origin JSON mutation; no MCP, cross-site forms, or offline replay. */
function mutation(request: NextRequest): void {
  if (request.headers.get("origin") !== MAPLE_ORIGIN || request.nextUrl.origin !== MAPLE_ORIGIN ||
      request.headers.get("sec-fetch-site") === "cross-site") {
    throw new FlowError("origin", 403, "Open Maple in your browser and try again.");
  }
}
async function body(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json") || Number(request.headers.get("content-length")) > 256_000) {
    throw new FlowError("body", 400, "That request couldn't be read.");
  }
  const text = await request.text();
  if (text.length > 256_000) throw new FlowError("body", 400, "That request is too large.");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new FlowError("body", 400, "That request couldn't be read."); }
}

/** Bound error messages: never pass Epic responses, OAuth codes, or patient data to analytics/logs. */
function failure(error: unknown): NextResponse {
  if (error instanceof FlowError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof FhirReadError) {
    return json({ error: error.code === "authorization" ? "MyChart access ended or didn't include those records. Please connect again." : error.code === "incomplete" ? "MyChart couldn't return a complete list. Nothing was imported. Please try again." : "MyChart records couldn't be loaded. Nothing was imported. Please try again.", code: error.code }, 502);
  }
  if (error instanceof store.EpicStoreError && error.code === "expired") return json({ error: "That review has expired or changed. Connect again.", code: "expired" }, 409);
  return json({ error: "Medical records are temporarily unavailable. Please try again.", code: "unavailable" }, 503);
}

function route(method: string, handler: (request: NextRequest, ctx: FamilyCtx) => Promise<Response>) {
  return withMember(`${method} /api/maple/epic`, async (request, _me, ctx) => {
    if (ctx.role !== "owner") return json({ error: "Only a family owner can import medical records." }, 403);
    try {
      if (method !== "GET") mutation(request);
      await store.cleanupExpired();
      return await handler(request, ctx);
    } catch (error) { return failure(error); }
  }, { write: true });
}

async function pending(ctx: FamilyCtx, config: EpicConfig) {
  const row = await store.getPending(ctx);
  if (!row || row.babyId !== ctx.babyId || row.providerId !== config.provider.id) return null;
  const value = unseal<Preview>(ctx, row.sealed);
  if (!value || value.fingerprint !== fingerprint(config)) return null;
  return { row, value };
}

async function status(ctx: FamilyCtx) {
  const config = epicConfig();
  const counts = await store.stats(ctx);
  const saved = config ? await pending(ctx, config) : null;
  const baby = saved ? await getBaby(ctx) : null;
  const birthDate = baby?.born_at ? dayKey(new Date(baby.born_at), baby.timezone) : null;
  return {
    enabled: !!config,
    provider: config ? { id: config.provider.id, name: config.provider.name, sandbox: config.provider.sandbox } : null,
    ...counts,
    pending: saved && baby ? {
      id: saved.row.id, stage: saved.value.stage, expiresAt: saved.row.expiresAt,
      patient: { name: saved.value.patient.name, birthDate: saved.value.patient.birthDate },
      baby: { name: baby.name, birthDate },
      matchesBirthDate: !!birthDate && birthDate === saved.value.patient.birthDate,
      ...(saved.value.stage === "measurements" ? { measurements: saved.value.measurements ?? [], skipped: saved.value.skipped ?? 0 } : {}),
    } : null,
  };
}

export const getStatus = route("GET", async (_request, ctx) => json(await status(ctx)));

export const start = route("POST", async (request, ctx) => {
  const config = requireConfig();
  if (request.headers.get("user-agent")?.includes(NATIVE_UA_TOKEN)) throw new FlowError("browser", 400, "Open Maple in Safari or Chrome to import medical records.");
  const baby = await getBaby(ctx);
  if (!config.provider.sandbox && !baby.born_at) throw new FlowError("birthday", 400, "Add your baby's birthday in Settings before connecting medical records.");
  if (!(await allowAttempt(request))) throw new FlowError("busy", 429, "Too many connection attempts. Please try again later.");
  const state = randomToken();
  const verifier = randomToken();
  const browser = randomToken();
  const expiresAt = new Date(Date.now() + REVIEW_TTL_MS).toISOString();
  await store.saveAttempt(ctx, {
    stateHash: hash(state), browserHash: browserHash(request, browser), expiresAt,
    sealed: seal(ctx, { verifier, fingerprint: fingerprint(config), babyId: baby.id, expiresAt } satisfies Attempt),
  });
  const response = json({ url: authorizationUrl(config, state, verifier) });
  response.cookies.set(BROWSER_COOKIE, browser, { path: CALLBACK_PATH, httpOnly: true, secure: config.origin.startsWith("https:"), sameSite: "lax", maxAge: REVIEW_TTL_MS / 1000 });
  return response;
});

function returnToSettings(error?: "denied" | "expired" | "failed") {
  const url = new URL(RETURN_PATH, MAPLE_ORIGIN);
  if (error) url.searchParams.set("epic", error);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(BROWSER_COOKIE, "", { path: CALLBACK_PATH, httpOnly: true, secure: url.protocol === "https:", sameSite: "lax", maxAge: 0 });
  return response;
}

export async function callback(request: NextRequest): Promise<Response> {
  let consumed: { ctx: FamilyCtx; stateHash: string } | null = null;
  try {
    const config = requireConfig();
    if (request.nextUrl.origin !== config.origin) return returnToSettings("failed");
    const signed = await sessionContext(request);
    if (!signed || signed.ctx.role !== "owner" || signed.ctx.status !== "active") return returnToSettings("expired");
    const ctx = signed.ctx;
    const params = request.nextUrl.searchParams;
    const state = params.get("state");
    const browser = request.cookies.get(BROWSER_COOKIE)?.value;
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) return returnToSettings("expired");
    const stateHash = hash(state);
    const sealed = await store.takeAttempt(ctx, stateHash, browserHash(request, browser));
    if (!sealed) return returnToSettings("expired");
    consumed = { ctx, stateHash };
    const attempt = unseal<Attempt>(ctx, sealed);
    if (!attempt || attempt.fingerprint !== fingerprint(config) || attempt.babyId !== ctx.babyId || Date.parse(attempt.expiresAt) <= Date.now()) return returnToSettings("expired");
    if (params.has("error")) return returnToSettings(params.get("error") === "access_denied" ? "denied" : "failed");
    const code = params.get("code");
    if (!code || code.length > 16_000) return returnToSettings("failed");
    const token = await exchangeCode(config, code, attempt.verifier);
    const tokenExpiresAt = Date.now() + token.expiresIn * 1000;
    const patient = await fetchPatient(config.provider.baseUrl, token.accessToken, token.patientId);
    const expiresAt = new Date(Math.min(Date.parse(attempt.expiresAt), tokenExpiresAt)).toISOString();
    await store.putPending(ctx, {
      id: randomUUID(), babyId: attempt.babyId, providerId: config.provider.id, expiresAt, attemptHash: stateHash,
      sealed: seal(ctx, { fingerprint: fingerprint(config), accessToken: token.accessToken, patient, stage: "patient" } satisfies Preview),
    });
    return returnToSettings();
  } catch { return returnToSettings("failed"); }
  finally {
    // A spent attempt must not retain its PKCE verifier even when Epic denies or fails.
    if (consumed) await store.clearAttempt(consumed.ctx, consumed.stateHash).catch(() => {});
  }
}

export const review = route("POST", async (request, ctx) => {
  const config = requireConfig();
  const input = await body(request);
  if (input.confirmPatient !== true) throw new FlowError("confirmation", 400, "Confirm whose record this is before continuing.");
  const saved = await pending(ctx, config);
  if (!saved) expired();
  if (input.pendingId !== saved.row.id) expired();
  const baby = await getBaby(ctx);
  const birthday = baby.born_at ? dayKey(new Date(baby.born_at), baby.timezone) : null;
  if (!config.provider.sandbox && (!birthday || birthday !== saved.value.patient.birthDate)) throw new FlowError("patient_mismatch", 409, "This record's birthday doesn't match your baby's. Check the baby selected in MyChart and the birthday in Maple.");
  if (saved.value.stage === "measurements") return json(await status(ctx));
  const result = await fetchGrowth(config.provider.baseUrl, saved.value.accessToken, saved.value.patient.id, baby.timezone);
  const measurements = config.provider.sandbox ? result.measurements : result.measurements.filter(m => dayKey(new Date(m.measuredAt), baby.timezone) >= birthday!);
  const value: Preview = { ...saved.value, stage: "measurements", measurements, skipped: result.skipped + result.measurements.length - measurements.length };
  if (!(await store.replacePending(ctx, saved.row.id, saved.row.sealed, seal(ctx, value)))) expired();
  return json(await status(ctx));
});

export const importSelected = route("POST", async (request, ctx) => {
  const config = requireConfig();
  if (config.provider.sandbox) throw new FlowError("sandbox", 400, "Test records can be previewed but can't be added to a family's log.");
  const input = await body(request);
  if (input.shareWithFamilyAndAssistants !== true) throw new FlowError("consent", 400, "Confirm sharing the selected measurements with your family and Maple's assistants.");
  if (!Array.isArray(input.measurementIds) || !input.measurementIds.length || input.measurementIds.length > 2000 || input.measurementIds.some(id => typeof id !== "string")) throw new FlowError("selection", 400, "Select measurements to import.");
  const saved = await pending(ctx, config);
  if (!saved || saved.value.stage !== "measurements") expired();
  if (input.pendingId !== saved.row.id) expired();
  const baby = await getBaby(ctx);
  if (!baby.born_at || dayKey(new Date(baby.born_at), baby.timezone) !== saved.value.patient.birthDate) throw new FlowError("patient_mismatch", 409, "Your baby's details changed. Connect to MyChart again.");
  const ids = new Set(input.measurementIds as string[]);
  const selected = (saved.value.measurements ?? []).filter(m => ids.has(m.id));
  if (selected.length !== ids.size) throw new FlowError("selection", 400, "That selection is no longer available. Start a new review.");
  return json(await store.importMeasurements(ctx, { pending: saved.row, patientId: saved.value.patient.id, expectedBirthDate: saved.value.patient.birthDate!, providerName: config.provider.name, measurements: selected }));
});

export const discard = route("DELETE", async (request, ctx) => {
  const input = await body(request);
  if (typeof input.pendingId !== "string" || !/^[0-9a-f-]{36}$/.test(input.pendingId)) throw new FlowError("review", 400, "Choose the pending connection to discard.");
  await store.discardPending(ctx, input.pendingId);
  return json({ ok: true });
});
export const removeImported = route("DELETE", async (_request, ctx) => json({ removed: await store.removeImports(ctx) }));
