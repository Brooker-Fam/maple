import { dayKey, startOfDay } from "../time";

/** Minimal, server-only FHIR reader. Never return raw bundles or upstream errors to the app. */
export type FhirPatient = { id: string; name: string; birthDate: string | null };
export type GrowthMeasurement = {
  id: string;
  measuredAt: string;
  /** The source's actual effectiveDateTime, including its original date-only precision. */
  originalDate: string;
  data: { weight_g?: number; length_cm?: number; head_cm?: number; at: "doctor" };
  label: string;
  originalValue: number;
  /** The validated UCUM code, never untrusted free-text unit display. */
  originalUnit: string;
};

export type FhirReadCode = "authorization" | "unavailable" | "invalid_response" | "incomplete";
export class FhirReadError extends Error {
  constructor(public readonly code: FhirReadCode) {
    // This error can cross a generic route logger: never retain a URL, body, token, or cause.
    super(`epic_${code}`);
    this.name = "FhirReadError";
  }
}

const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const ID = /^[A-Za-z0-9.-]{1,64}$/;
type Metric = "weight_g" | "length_cm" | "head_cm";
const METRICS: Record<string, Metric> = {
  "29463-7": "weight_g",
  "3141-9": "weight_g",
  "8302-2": "length_cm",
  "8306-3": "length_cm",
  "8287-5": "head_cm",
};
const LABELS: Record<Metric, string> = { weight_g: "Weight", length_cm: "Length", head_cm: "Head circumference" };
const BOUNDS: Record<Metric, readonly [number, number]> = {
  weight_g: [500, 30000], length_cm: [25, 130], head_cm: [20, 60],
};
const MASS: Record<string, number> = { g: 1, kg: 1000, "[lb_av]": 453.59237, "[oz_av]": 28.349523125 };
const LENGTH: Record<string, number> = { cm: 1, m: 100, mm: 0.1, "[in_i]": 2.54 };
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_ENTRIES = 2000;
const REQUEST_MS = 8000;
const TOTAL_MS = 25000;

type Json = Record<string, unknown>;
function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

export function validFhirId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** Reject rolled dates such as February 31, which Date.parse otherwise accepts. */
export function validFhirDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function parsePatient(resource: unknown, expectedId: string): FhirPatient {
  const r = object(resource);
  if (!validFhirId(expectedId) || !r || r.resourceType !== "Patient" || r.id !== expectedId || r.active === false) {
    throw new FhirReadError("invalid_response");
  }
  const names = Array.isArray(r.name) ? r.name.map(object).filter((v): v is Json => !!v) : [];
  const name = names.find((v) => v.use === "official") ?? names.find((v) => v.use !== "old") ?? names[0];
  const given = Array.isArray(name?.given) ? name.given.filter((v): v is string => typeof v === "string") : [];
  const full = typeof name?.text === "string" ? name.text : [...given, typeof name?.family === "string" ? name.family : ""].join(" ");
  const cleaned = full.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleaned) throw new FhirReadError("invalid_response");
  return { id: expectedId, name: cleaned, birthDate: validFhirDay(r.birthDate) ? r.birthDate : null };
}

/** An explicit offset is mandatory for a time; a date alone is anchored in the baby's zone. */
export function measurementInstant(value: unknown, tz: string, now = Date.now()): string | null {
  if (typeof value !== "string" || value.length > 50 || !Number.isFinite(now)) return null;
  try {
    if (validFhirDay(value)) {
      if (value > dayKey(now, tz)) return null;
      const instant = startOfDay(value, tz);
      return dayKey(instant, tz) === value ? instant.toISOString() : null;
    }
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!m || !validFhirDay(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) return null;
    if (m[5] !== "Z" && (Number(m[7]) > 14 || Number(m[8]) > 59 || (Number(m[7]) === 14 && Number(m[8]) !== 0))) return null;
    const instant = Date.parse(value);
    return Number.isFinite(instant) && instant <= now ? new Date(instant).toISOString() : null;
  } catch {
    return null;
  }
}

/** Resolve only references to this selected patient at this exact FHIR endpoint. */
function samePatient(reference: unknown, base: URL, patientId: string): boolean {
  if (typeof reference !== "string") return false;
  if (reference === `Patient/${patientId}`) return true;
  try {
    const url = new URL(reference);
    return !url.username && !url.password && !url.search && !url.hash && url.href === `${base.href}/Patient/${patientId}`;
  } catch {
    return false;
  }
}

/** Malformed, provisional, unrelated, and unsupported observations are counted as skipped by the caller. */
export function parseGrowthObservation(resource: unknown, patientId: string, baseUrl: string, tz: string, now = Date.now()): GrowthMeasurement | null {
  const r = object(resource);
  if (!validFhirId(patientId) || !r || r.resourceType !== "Observation" || !validFhirId(r.id)) return null;
  if (r.status !== "final" && r.status !== "amended" && r.status !== "corrected") return null;
  const base = fhirBase(baseUrl);
  if (!samePatient(object(r.subject)?.reference, base, patientId)) return null;
  const coding = object(r.code)?.coding;
  const metrics = new Set<Metric>();
  if (Array.isArray(coding)) for (const raw of coding) {
    const c = object(raw);
    if (c?.system === LOINC && typeof c.code === "string" && Object.hasOwn(METRICS, c.code)) metrics.add(METRICS[c.code]);
  }
  if (metrics.size !== 1 || r.dataAbsentReason !== undefined) return null;
  const metric = [...metrics][0];
  const quantity = object(r.valueQuantity);
  if (!quantity || quantity.system !== UCUM || quantity.comparator != null || typeof quantity.value !== "number" || !Number.isFinite(quantity.value) || typeof quantity.code !== "string") return null;
  const factors = metric === "weight_g" ? MASS : LENGTH;
  if (!Object.hasOwn(factors, quantity.code)) return null;
  const converted = quantity.value * factors[quantity.code];
  const [min, max] = BOUNDS[metric];
  if (!Number.isFinite(converted) || converted < min || converted > max) return null;
  const measuredAt = measurementInstant(r.effectiveDateTime, tz, now);
  if (!measuredAt) return null;
  return {
    id: r.id,
    measuredAt,
    originalDate: r.effectiveDateTime as string,
    data: { [metric]: Math.round(converted * 10000) / 10000, at: "doctor" },
    label: LABELS[metric],
    originalValue: quantity.value,
    originalUnit: quantity.code,
  };
}

function fhirBase(raw: string): URL {
  try {
    const base = new URL(raw);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || /%|\\/.test(base.pathname)) throw new Error();
    base.pathname = base.pathname.replace(/\/+$/, "");
    // The fixed endpoint is supplied by server configuration, never the browser or FHIR response.
    if (!base.pathname.endsWith("/FHIR/R4")) throw new Error();
    return base;
  } catch {
    throw new FhirReadError("invalid_response");
  }
}

function observationUrl(value: string, base: URL, patientId: string): URL {
  try {
    // Some FHIR servers return a query-only continuation, others a resource-relative or absolute URL.
    const url = new URL(value, `${base.href}/Observation`);
    if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password || url.hash || url.pathname !== `${base.pathname}/Observation`) throw new Error();
    for (const key of ["patient", "subject"]) for (const ref of url.searchParams.getAll(key)) {
      if (ref !== patientId && ref !== `Patient/${patientId}`) throw new Error();
    }
    return url;
  } catch {
    throw new FhirReadError("incomplete");
  }
}

type ReadBudget = { deadline: number; bytes: number };
async function readJson(url: URL, token: string, budget: ReadBudget): Promise<unknown> {
  if (!token || token.length > 16384 || /[^\x21-\x7e]/.test(token)) throw new FhirReadError("authorization");
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) throw new FhirReadError("incomplete");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(remaining, REQUEST_MS));
  try {
    const res = await fetch(url.href, {
      headers: { Accept: "application/fhir+json", Authorization: `Bearer ${token}` },
      cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) throw new FhirReadError("authorization");
    if (!res.ok || res.redirected) throw new FhirReadError("unavailable");
    if (!res.body) throw new FhirReadError("invalid_response");
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new FhirReadError("incomplete");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        budget.bytes += part.value.byteLength;
        if (bytes > MAX_BYTES || budget.bytes > MAX_TOTAL_BYTES || Date.now() > budget.deadline) throw new FhirReadError("incomplete");
        chunks.push(part.value);
      }
    } finally {
      // Stop excessive bodies and release the connection even after a parsing/size failure.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof FhirReadError) throw error;
    throw new FhirReadError("unavailable");
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

export async function fetchPatient(baseUrl: string, accessToken: string, patientId: string): Promise<FhirPatient> {
  if (!validFhirId(patientId)) throw new FhirReadError("invalid_response");
  const base = fhirBase(baseUrl);
  const body = await readJson(new URL(`${base.href}/Patient/${patientId}`), accessToken, { deadline: Date.now() + TOTAL_MS, bytes: 0 });
  return parsePatient(body, patientId);
}

export async function fetchGrowth(baseUrl: string, accessToken: string, patientId: string, tz: string): Promise<{ measurements: GrowthMeasurement[]; skipped: number }> {
  if (!validFhirId(patientId)) throw new FhirReadError("invalid_response");
  const base = fhirBase(baseUrl);
  let next: URL | null = new URL(`${base.href}/Observation`);
  next.search = new URLSearchParams({ patient: patientId, category: "vital-signs", code: Object.keys(METRICS).map((code) => `${LOINC}|${code}`).join(","), _count: "100" }).toString();
  const budget = { deadline: Date.now() + TOTAL_MS, bytes: 0 };
  const visited = new Set<string>();
  const matchedResources = new Set<string>();
  const measurements = new Map<string, GrowthMeasurement>();
  let skipped = 0;
  let entries = 0;
  let expectedTotal: number | null = null;
  while (next) {
    if (visited.size >= MAX_PAGES || visited.has(next.href)) throw new FhirReadError("incomplete");
    visited.add(next.href);
    const bundle = object(await readJson(next, accessToken, budget));
    if (!bundle || bundle.resourceType !== "Bundle" || bundle.type !== "searchset" || (bundle.entry !== undefined && !Array.isArray(bundle.entry))) throw new FhirReadError("invalid_response");
    if (bundle.total !== undefined) {
      if (typeof bundle.total !== "number" || !Number.isSafeInteger(bundle.total) || bundle.total < 0) throw new FhirReadError("invalid_response");
      expectedTotal = Math.max(expectedTotal ?? 0, bundle.total);
      if (expectedTotal > MAX_ENTRIES) throw new FhirReadError("incomplete");
    }
    for (const raw of (bundle.entry ?? []) as unknown[]) {
      if (++entries > MAX_ENTRIES) throw new FhirReadError("incomplete");
      const entry = object(raw);
      const resource = object(entry?.resource);
      // Outcomes can signal a partial search, and must not quietly become a successful empty import.
      if (!resource || resource.resourceType === "OperationOutcome" || object(entry?.search)?.mode === "outcome") throw new FhirReadError("incomplete");
      if (validFhirId(resource.id) && resource.resourceType === "Observation") matchedResources.add(resource.id);
      const measurement = parseGrowthObservation(resource, patientId, base.href, tz);
      if (!measurement) { skipped++; continue; }
      const previous = measurements.get(measurement.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(measurement)) throw new FhirReadError("incomplete");
      measurements.set(measurement.id, measurement);
    }
    if (bundle.link !== undefined && !Array.isArray(bundle.link)) throw new FhirReadError("invalid_response");
    const nextLinks = ((bundle.link ?? []) as unknown[]).map(object).filter((link) => link?.relation === "next");
    if (nextLinks.length > 1 || (nextLinks.length === 1 && typeof nextLinks[0]?.url !== "string")) throw new FhirReadError("incomplete");
    next = nextLinks.length ? observationUrl(nextLinks[0]!.url as string, base, patientId) : null;
  }
  // Repeated records across pages must not hide a missing result behind the advertised total.
  if (expectedTotal !== null && matchedResources.size < expectedTotal) throw new FhirReadError("incomplete");
  return { measurements: [...measurements.values()].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.id.localeCompare(b.id)), skipped };
}
