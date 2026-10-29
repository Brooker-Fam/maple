/** Synthetic, offline checks: no real tokens, people, medical records, or network. */
import assert from "node:assert/strict";
import {
  fetchGrowth, fetchPatient, FhirReadError, measurementInstant,
  parseGrowthObservation, parsePatient, validFhirDay,
} from "../src/lib/maple/epic/fhir";

const BASE = "https://fhir.example.test/api/FHIR/R4";
const PATIENT = "synthetic-baby";
const TOKEN = "synthetic-token";
const TZ = "America/New_York";
const NOW = Date.parse("2026-10-29T18:00:00Z");
const originalFetch = globalThis.fetch;
let passed = 0;
let failed = 0;
type Row = Record<string, unknown>;

function observation(patch: Row = {}): Row {
  return {
    resourceType: "Observation", id: "weight-1", status: "final",
    subject: { reference: `Patient/${PATIENT}` },
    code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
    effectiveDateTime: "2020-06-15T09:30:00-04:00",
    valueQuantity: { value: 3.25, system: "http://unitsofmeasure.org", code: "kg" },
    ...patch,
  };
}
const quantity = (value: unknown, code: string, patch: Row = {}) => ({ value, system: "http://unitsofmeasure.org", code, ...patch });
const coding = (code: string) => ({ coding: [{ system: "http://loinc.org", code }] });
const parse = (patch: Row = {}) => parseGrowthObservation(observation(patch), PATIENT, BASE, TZ, NOW);
const bundle = (resources: unknown[], patch: Row = {}) => ({ resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource })), ...patch });
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/fhir+json", ...headers } });

function mockFetch(fn: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init) => fn(new URL(String(input)), init)) as typeof fetch;
}

async function rejectsCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof FhirReadError);
    assert.equal(error.code, code);
    assert.equal(error.message, `epic_${code}`);
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return true;
  });
}

async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`, error);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  await check("patient identity is minimal and must match the token's selected patient", () => {
    const resource = {
      resourceType: "Patient", id: PATIENT, active: true, birthDate: "2020-06-10",
      name: [{ use: "old", text: "Old synthetic name" }, { use: "official", given: ["Sample"], family: "Infant" }],
      address: [{ text: "Synthetic address that must not be returned" }], telecom: [{ value: "private" }],
    };
    assert.deepEqual(parsePatient(resource, PATIENT), { id: PATIENT, name: "Sample Infant", birthDate: "2020-06-10" });
    assert.throws(() => parsePatient(resource, "another-person"), FhirReadError);
    assert.throws(() => parsePatient({ ...resource, active: false }, PATIENT), FhirReadError);
    assert.throws(() => parsePatient({ ...resource, name: [] }, PATIENT), FhirReadError);
    assert.equal(parsePatient({ ...resource, birthDate: "2020-02-31" }, PATIENT).birthDate, null);
  });

  await check("mass units convert into Maple grams without changing source value", () => {
    assert.deepEqual(parse()?.data, { weight_g: 3250, at: "doctor" });
    assert.equal(parse()?.originalValue, 3.25);
    assert.equal(parse()?.originalUnit, "kg");
    assert.equal(parse({ valueQuantity: quantity(3250, "g") })?.data.weight_g, 3250);
    assert.equal(parse({ code: coding("3141-9"), valueQuantity: quantity(8, "[lb_av]") })?.data.weight_g, 3628.739);
    assert.equal(parse({ valueQuantity: quantity(128, "[oz_av]") })?.data.weight_g, 3628.739);
  });

  await check("length, height and head circumference use only exact LOINC and UCUM codes", () => {
    assert.deepEqual(parse({ code: coding("8306-3"), valueQuantity: quantity(20, "[in_i]") })?.data, { length_cm: 50.8, at: "doctor" });
    assert.equal(parse({ code: coding("8302-2"), valueQuantity: quantity(0.508, "m") })?.data.length_cm, 50.8);
    assert.equal(parse({ code: coding("8306-3"), valueQuantity: quantity(508, "mm") })?.data.length_cm, 50.8);
    assert.equal(parse({ code: coding("8287-5"), valueQuantity: quantity(35, "cm") })?.data.head_cm, 35);
    assert.equal(parse({ code: { coding: [{ system: "urn:local", code: "29463-7" }] } }), null);
    assert.equal(parse({ code: coding("8289-1"), valueQuantity: quantity(50, "%") }), null);
    assert.equal(parse({ code: { coding: [...(coding("29463-7").coding), ...(coding("8287-5").coding)] } }), null);
  });

  await check("unknown, comparated, non-finite, missing and implausible values stay out", () => {
    for (const value of [quantity(3, "lb"), quantity(3, "kg", { system: "urn:local" }), quantity(3, "kg", { comparator: "<" }), quantity("3", "kg"), quantity(NaN, "kg"), quantity(0.1, "kg"), quantity(31, "kg")]) {
      assert.equal(parse({ valueQuantity: value }), null);
    }
    assert.equal(parse({ valueQuantity: undefined }), null);
    assert.equal(parse({ dataAbsentReason: { text: "unknown" } }), null);
    assert.equal(parse({ code: coding("8287-5"), valueQuantity: quantity(61, "cm") }), null);
  });

  await check("date-only measurements retain the source day through timezone and DST", () => {
    assert.equal(measurementInstant("2020-06-15", TZ, NOW), "2020-06-15T04:00:00.000Z");
    assert.equal(measurementInstant("2020-12-15", TZ, NOW), "2020-12-15T05:00:00.000Z");
    assert.equal(measurementInstant("2020-03-08", TZ, NOW), "2020-03-08T05:00:00.000Z");
    assert.equal(measurementInstant("2020-06-15", "Pacific/Auckland", NOW), "2020-06-14T12:00:00.000Z");
    assert.equal(parse({ effectiveDateTime: "2020-06-15" })?.originalDate, "2020-06-15");
    assert.equal(parse()?.measuredAt, "2020-06-15T13:30:00.000Z");
  });

  await check("invalid, ambiguous, missing and future measurement dates are not invented", () => {
    for (const date of ["2020", "2020-06", "2020-02-31", "2020-06-15T09:30:00", "2020-06-15T24:30:00Z", "2020-06-15T09:60:00Z", "2020-06-15T09:30:00+14:30", "2030-01-01", "2030-01-01T00:00:00Z", "0000-01-01"]) {
      assert.equal(parse({ effectiveDateTime: date }), null, date);
    }
    assert.equal(parse({ effectiveDateTime: undefined, issued: "2020-06-15T09:30:00Z" }), null);
    assert.equal(validFhirDay("2020-02-29"), true);
    assert.equal(validFhirDay("2019-02-29"), false);
  });

  await check("only final values belonging to the authorized patient are considered", () => {
    for (const status of ["registered", "preliminary", "cancelled", "entered-in-error", "unknown"]) assert.equal(parse({ status }), null);
    for (const status of ["final", "amended", "corrected"]) assert.ok(parse({ status }));
    for (const reference of ["Patient/someone-else", `https://foreign.example/Patient/${PATIENT}`, `Patient/${PATIENT}/_history/1`, `Patient/${PATIENT}?x=1`]) {
      assert.equal(parse({ subject: { reference } }), null);
    }
    assert.ok(parse({ subject: { reference: `${BASE}/Patient/${PATIENT}` } }));
    assert.equal(parse({ id: "../../Patient/another" }), null);
  });

  await check("patient HTTP read has fixed resource path and no redirect or cache exposure", async () => {
    let calls = 0;
    mockFetch((url, init) => {
      calls++;
      assert.equal(url.href, `${BASE}/Patient/${PATIENT}`);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      assert.ok(init?.signal);
      return response({ resourceType: "Patient", id: PATIENT, name: [{ text: "Synthetic Infant" }], birthDate: "2020-06-10" });
    });
    assert.equal((await fetchPatient(BASE, TOKEN, PATIENT)).name, "Synthetic Infant");
    assert.equal(calls, 1);
    await rejectsCode(() => fetchPatient(BASE, TOKEN, "../sensitive"), "invalid_response");
    assert.equal(calls, 1);
  });

  await check("growth search narrows codes, follows safe pagination, and reports skipped observations", async () => {
    let calls = 0;
    mockFetch((url) => {
      calls++;
      assert.equal(url.pathname, "/api/FHIR/R4/Observation");
      if (calls === 1) {
        assert.equal(url.searchParams.get("patient"), PATIENT);
        assert.equal(url.searchParams.get("category"), "vital-signs");
        assert.equal(url.searchParams.get("code")?.split(",").length, 5);
        return response(bundle([observation(), observation({ id: "preliminary", status: "preliminary" })], { total: 3, link: [{ relation: "next", url: "?cursor=synthetic-second-page" }] }));
      }
      assert.equal(url.searchParams.get("cursor"), "synthetic-second-page");
      return response(bundle([observation({ id: "length-1", code: coding("8306-3"), valueQuantity: quantity(51, "cm") })], { total: 3 }));
    });
    const result = await fetchGrowth(BASE, TOKEN, PATIENT, TZ);
    assert.equal(calls, 2);
    assert.equal(result.measurements.length, 2);
    assert.equal(result.skipped, 1);
  });

  await check("pagination cannot send a bearer token outside its exact endpoint or patient", async () => {
    const badLinks = [
      "https://foreign.example/api/FHIR/R4/Observation", `${BASE}/Patient/${PATIENT}`,
      `${BASE}/Observation/extra`, `${BASE}/Observation?patient=someone-else`,
      `${BASE}/Observation?subject=Patient/someone-else`, `${BASE}/Observation#fragment`,
      "https://user:password@fhir.example.test/api/FHIR/R4/Observation", "http://fhir.example.test/api/FHIR/R4/Observation",
    ];
    for (const url of badLinks) {
      let calls = 0;
      mockFetch(() => { calls++; return response(bundle([observation()], { link: [{ relation: "next", url }] })); });
      await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "incomplete");
      assert.equal(calls, 1);
    }
  });

  await check("partial search results and missing pages never become a successful import", async () => {
    for (const body of [
      bundle([observation()], { total: 2 }),
      bundle([{ resourceType: "OperationOutcome", issue: [{ severity: "warning", diagnostics: "private upstream text" }] }]),
      bundle([observation()], { total: 2001 }),
      bundle([observation()], { link: [{ relation: "next" }] }),
    ]) {
      mockFetch(() => response(body));
      await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "incomplete");
    }
    mockFetch(() => response({ resourceType: "OperationOutcome", issue: [{ diagnostics: "private upstream text" }] }));
    await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "invalid_response");
  });

  await check("pagination cycles and conflicting repeated observations fail closed", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return response(bundle([observation()], { link: [{ relation: "next", url: `${BASE}/Observation?cursor=same` }] }));
    });
    await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "incomplete");
    assert.equal(calls, 2);
    mockFetch(() => response(bundle([observation(), observation({ valueQuantity: quantity(3.4, "kg") })])));
    await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "incomplete");
    mockFetch(() => response(bundle([observation(), observation()], { total: 2 })));
    await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "incomplete");
  });

  await check("upstream bodies, tokens and URLs do not escape in error messages or causes", async () => {
    mockFetch(() => response({ private: `${TOKEN} sensitive-record` }, 401));
    await rejectsCode(() => fetchPatient(BASE, TOKEN, PATIENT), "authorization");
    mockFetch(() => { throw new Error(`network failed ${BASE}/Patient/${PATIENT}?token=${TOKEN}`); });
    await rejectsCode(() => fetchPatient(BASE, TOKEN, PATIENT), "unavailable");
    mockFetch(() => response({ private: `${TOKEN} sensitive-record` }, 500));
    await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "unavailable");
  });

  await check("oversized declared and streamed bodies are stopped without partial results", async () => {
    mockFetch(() => response({}, 200, { "content-length": String(3 * 1024 * 1024) }));
    await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "incomplete");
    let cancelled = false;
    mockFetch(() => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    })));
    await rejectsCode(() => fetchGrowth(BASE, TOKEN, PATIENT, TZ), "incomplete");
    assert.equal(cancelled, true);
  });

  await check("empty valid search is an empty import, and credentials are never sent for an invalid base", async () => {
    let calls = 0;
    mockFetch(() => { calls++; return response({ resourceType: "Bundle", type: "searchset", total: 0 }); });
    assert.deepEqual(await fetchGrowth(BASE, TOKEN, PATIENT, TZ), { measurements: [], skipped: 0 });
    await rejectsCode(() => fetchGrowth("http://insecure.example/api/FHIR/R4", TOKEN, PATIENT, TZ), "invalid_response");
    await rejectsCode(() => fetchGrowth(`${BASE}?redirect=evil`, TOKEN, PATIENT, TZ), "invalid_response");
    await rejectsCode(() => fetchGrowth(BASE, "bad\r\nheader", PATIENT, TZ), "authorization");
    assert.equal(calls, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

void main();
