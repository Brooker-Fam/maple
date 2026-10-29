/** Synthetic route/OAuth checks. Only PGlite and a closed, in-process fetch mock are used. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { FamilyCtx } from "../src/lib/maple/family";

const BASE = "https://maple.example.test";
Object.assign(process.env, {
  NODE_ENV: "test", NEXT_PUBLIC_MAPLE_ORIGIN: BASE,
  MAPLE_SESSION_SECRET: "epic-flow-check-session-secret",
  MCP_SECRET: "epic-flow-check-rate-secret",
  MAPLE_EPIC_ENABLED: "1", MAPLE_EPIC_ENVIRONMENT: "albany-med",
  MAPLE_EPIC_CLIENT_ID: "synthetic-epic-client",
  MAPLE_EPIC_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.VERCEL_ENV;
delete process.env.MAPLE_READ_ONLY;

type Status = {
  enabled: boolean; importedCount: number;
  pending: null | {
    id: string; stage: "patient" | "measurements"; matchesBirthDate: boolean;
    patient: { name: string; birthDate: string | null };
    measurements?: { id: string }[]; skipped?: number;
  };
};

async function main() {
  // Dynamic imports ensure origin/configuration is initialized with synthetic settings.
  const { done, freshDb, seedFamilies, sql, test } = await import("./tenancy/harness");
  const auth = await import("../src/lib/maple/auth");
  const flow = await import("../src/lib/maple/epic/flow");
  const config = await import("../src/lib/maple/epic/config");
  const crypto = await import("../src/lib/maple/epic/crypto");
  const oauth = await import("../src/lib/maple/epic/oauth");
  const { setLaterRunner } = await import("../src/lib/maple/push-hooks");
  setLaterRunner(() => {});

  const requests: { url: string; method: string; body: URLSearchParams }[] = [];
  const unexpected: string[] = [];
  let patientId = "synthetic-child";
  let birthDate = "2026-10-10";
  let tokenOverrides: Record<string, unknown> = {};
  const observation = (id: string, code: string, value: number, unit: string, at = "2026-10-20T12:00:00Z") => ({
    resourceType: "Observation", id, status: "final",
    subject: { reference: `Patient/${patientId}` }, effectiveDateTime: at,
    code: { coding: [{ system: "http://loinc.org", code }] },
    valueQuantity: { value, system: "http://unitsofmeasure.org", code: unit },
  });
  let observations: ReturnType<typeof observation>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(String(init?.body ?? ""));
    requests.push({ url: url.href, method, body });
    const provider = Object.values(config.EPIC_PROVIDERS).find(p => url.href === p.tokenUrl || url.href.startsWith(`${p.baseUrl}/`));
    if (!provider) {
      unexpected.push(url.href);
      throw new Error("External requests are forbidden in Epic flow checks");
    }
    if (url.href === provider.tokenUrl) {
      assert.equal(method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("client_id"), "synthetic-epic-client");
      assert.equal(body.get("redirect_uri"), `${BASE}/api/maple/epic/callback`);
      assert.match(body.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/);
      return Response.json({ access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 600,
        patient: patientId, id_token: "parent-RelatedPerson-is-not-the-patient", ...tokenOverrides });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-access-token");
    assert.equal(init?.redirect, "error");
    if (url.href === `${provider.baseUrl}/Patient/${patientId}`) {
      return Response.json({ resourceType: "Patient", id: patientId, active: true,
        name: [{ use: "official", given: ["Juniper"], family: "Test" }], birthDate });
    }
    if (url.pathname === new URL(`${provider.baseUrl}/Observation`).pathname) {
      assert.equal(url.searchParams.get("patient"), patientId);
      assert.equal(url.searchParams.get("category"), "vital-signs");
      return Response.json({ resourceType: "Bundle", type: "searchset", total: observations.length,
        entry: observations.map(resource => ({ resource, search: { mode: "match" } })) });
    }
    unexpected.push(url.href);
    throw new Error("Unrecognized synthetic Epic request");
  };

  try {
    await freshDb();
    const { alpha, beta } = await seedFamilies();
    const ctx: FamilyCtx = { familyId: alpha.familyId, babyId: alpha.babyId, tz: alpha.tz,
      member: alpha.owner, role: "owner", status: "active" };
    const session = (member = alpha.owner, familyId = alpha.familyId) =>
      `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(member, familyId))}`;
    let ownerCookie = session();
    let ip = 0;
    const request = (path: string, method = "GET", payload?: unknown, cookie = ownerCookie, headers: Record<string, string> = {}) =>
      new NextRequest(`${BASE}/api/maple/epic${path}`, { method,
        headers: { cookie, origin: BASE, "sec-fetch-site": "same-origin", "content-type": "application/json",
          "x-real-ip": `192.0.2.${++ip % 250 + 1}`, ...headers },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    const getStatus = async () => {
      const response = await flow.getStatus(request(""));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json() as Promise<Status>;
    };
    const reviewRequest = async (payload: Record<string, unknown>) => request("/review", "POST", {
      pendingId: (await getStatus()).pending?.id, ...payload,
    });
    const importRequest = async (payload: Record<string, unknown>) => request("/import", "POST", {
      pendingId: (await getStatus()).pending?.id, ...payload,
    });
    const discardRequest = async () => request("", "DELETE", { pendingId: (await getStatus()).pending?.id });
    const cookieValue = (response: Response, name: string) => {
      const line = response.headers.getSetCookie().find(v => v.startsWith(`${name}=`));
      return line?.match(/^[^=]+=([^;]*)/)?.[1] ?? "";
    };
    const begin = async () => {
      const response = await flow.start(request("/start", "POST", {}));
      assert.equal(response.status, 200, await response.clone().text());
      const url = new URL((await response.json()).url);
      const browser = cookieValue(response, "maple_epic_browser");
      assert.match(browser, /^[A-Za-z0-9_-]{43}$/);
      return { response, url, browser, state: url.searchParams.get("state")! };
    };
    type Started = Awaited<ReturnType<typeof begin>>;
    const callback = (started: Started, options: { state?: string; browser?: string; cookie?: string; error?: string; origin?: string } = {}) => {
      const params = new URLSearchParams({ state: options.state ?? started.state, code: "synthetic-authorization-code" });
      if (options.error) params.set("error", options.error);
      return flow.callback(new NextRequest(`${options.origin ?? BASE}/api/maple/epic/callback?${params}`, {
        headers: { cookie: `${options.cookie ?? ownerCookie}; maple_epic_browser=${options.browser ?? started.browser}` },
      }));
    };
    const returned = (response: Response, error?: string) => {
      assert.equal(response.status, 303);
      const location = new URL(response.headers.get("location")!);
      assert.equal(location.origin, BASE);
      assert.equal(location.pathname, "/maple");
      assert.equal(location.hash, "#family/medical-records");
      assert.equal(location.searchParams.get("epic"), error ?? null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.ok(!location.href.includes("synthetic-authorization-code"));
    };
    const connect = async () => { const started = await begin(); returned(await callback(started)); return started; };
    const reviewed = async () => {
      await connect();
      const response = await flow.review(await reviewRequest({ confirmPatient: true }));
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<Status>;
    };
    const expectCode = async (response: Response, status: number, code: string) => {
      assert.equal(response.status, status, await response.clone().text());
      assert.equal((await response.json()).code, code);
    };
    const check = async (name: string, run: () => unknown | Promise<unknown>) => test(name, async () => {
      process.env.MAPLE_EPIC_ENABLED = "1";
      process.env.MAPLE_EPIC_ENVIRONMENT = "albany-med";
      await sql("DELETE FROM maple_epic_pending");
      await sql("DELETE FROM maple_epic_attempts");
      await sql("DELETE FROM maple_entries WHERE client_id LIKE 'epic:%'");
      await sql("TRUNCATE upload_rate_limit");
      await sql("UPDATE maple_babies SET born_at = '2026-10-10T08:00:00Z' WHERE id = $1", [alpha.babyId]);
      ownerCookie = session();
      patientId = "synthetic-child";
      birthDate = "2026-10-10";
      tokenOverrides = {};
      observations = [observation("weight-1", "29463-7", 3.5, "kg"), observation("length-1", "8306-3", 51, "cm")];
      requests.length = 0;
      unexpected.length = 0;
      await run();
      assert.deepEqual(unexpected, [], "no unrecognized or external network calls");
    });

    await check("configuration fails closed and encrypted payloads bind family/member", () => {
      const env = { ...process.env };
      assert.equal(config.epicConfig({ ...env, MAPLE_EPIC_ENABLED: "0" }), null);
      assert.equal(config.epicConfig({ ...env, MAPLE_EPIC_ENVIRONMENT: "user-supplied-url" }), null);
      assert.equal(config.epicConfig({ ...env, MAPLE_EPIC_CLIENT_ID: "" }), null);
      assert.equal(config.epicConfig({ ...env, MAPLE_EPIC_ENCRYPTION_KEY: "bad" }), null);
      const sealed = crypto.seal(ctx, { private: "synthetic-value" });
      assert.deepEqual(crypto.unseal(ctx, sealed), { private: "synthetic-value" });
      assert.equal(crypto.unseal({ ...ctx, familyId: beta.familyId }, sealed), null);
      assert.equal(crypto.unseal({ ...ctx, member: alpha.member }, sealed), null);
      const tampered = Buffer.from(sealed, "base64url"); tampered[28] ^= 1;
      assert.equal(crypto.unseal(ctx, tampered.toString("base64url")), null);
      assert.equal(crypto.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });

    await check("all import routes require an owner and a valid current session", async () => {
      const handlers = [flow.getStatus, flow.start, flow.review, flow.importSelected, flow.discard];
      for (const cookie of ["", session(alpha.member), session(alpha.viewer)]) {
        for (const handler of handlers) {
          const response = await handler(request("", "POST", {}, cookie));
          assert.equal(response.status, cookie ? 403 : 401);
        }
      }
      assert.equal((await getStatus()).enabled, true);
      assert.equal(requests.length, 0);
    });

    await check("browser mutations reject missing/foreign origins and cross-site requests", async () => {
      const cases: Record<string, string>[] = [{ origin: "" }, { origin: "https://elsewhere.example" }, { "sec-fetch-site": "cross-site" }];
      for (const headers of cases) {
        await expectCode(await flow.start(request("/start", "POST", {}, ownerCookie, headers)), 403, "origin");
        await expectCode(await flow.discard(request("", "DELETE", undefined, ownerCookie, headers)), 403, "origin");
      }
      assert.equal((await sql("SELECT * FROM maple_epic_attempts")).length, 0);
    });

    await check("disabled configuration and native shells cannot start OAuth", async () => {
      process.env.MAPLE_EPIC_ENABLED = "0";
      assert.equal((await getStatus()).enabled, false);
      await expectCode(await flow.start(request("/start", "POST", {})), 503, "disabled");
      process.env.MAPLE_EPIC_ENABLED = "1";
      await expectCode(await flow.start(request("/start", "POST", {}, ownerCookie, { "user-agent": "Maple-Native-App/1.1 (ios)" })), 400, "browser");
      assert.equal((await sql("SELECT * FROM maple_epic_attempts")).length, 0);
    });

    await check("start binds PKCE, narrow scope, browser cookie and exact redirect", async () => {
      const started = await begin();
      const current = config.epicConfig()!;
      assert.equal(started.url.origin, new URL(current.provider.authorizeUrl).origin);
      assert.equal(started.url.searchParams.get("scope"), "launch/patient patient/Patient.read patient/Observation.read");
      assert.equal(started.url.searchParams.get("aud"), current.provider.baseUrl);
      assert.equal(started.url.searchParams.get("redirect_uri"), current.redirectUri);
      assert.equal(started.url.searchParams.get("code_challenge_method"), "S256");
      const cookie = started.response.headers.getSetCookie()[0];
      for (const attribute of ["HttpOnly", "Secure", "SameSite=lax", "Path=/api/maple/epic/callback"]) assert.ok(cookie.includes(attribute), attribute);
      const [row] = await sql("SELECT * FROM maple_epic_attempts");
      assert.equal(row.state_hash, crypto.hash(started.state));
      const payload = crypto.unseal<{ verifier: string }>(ctx, String(row.sealed_payload));
      assert.ok(payload);
      assert.equal(started.url.searchParams.get("code_challenge"), crypto.pkceChallenge(payload.verifier));
      assert.ok(!JSON.stringify(row).includes(started.state));
      assert.equal(requests.length, 0);
    });

    await check("callback binds state, browser, session, family and origin without consuming a valid attempt", async () => {
      const started = await begin();
      returned(await callback(started, { state: crypto.randomToken() }), "expired");
      returned(await callback(started, { browser: crypto.randomToken() }), "expired");
      returned(await callback(started, { cookie: "" }), "expired");
      returned(await callback(started, { cookie: session() }), "expired");
      returned(await callback(started, { cookie: session(beta.owner, beta.familyId) }), "expired");
      returned(await callback(started, { origin: "https://elsewhere.example" }), "failed");
      assert.equal(requests.length, 0);
      returned(await callback(started));
      assert.equal(requests.length, 2, "only token and selected patient are read");
      returned(await callback(started), "expired");
      assert.equal(requests.length, 2, "callback cannot replay");
    });

    await check("denial and malformed token responses consume attempts without retaining secrets", async () => {
      const denied = await begin();
      returned(await callback(denied, { error: "access_denied" }), "denied");
      assert.equal(requests.length, 0);
      returned(await callback(denied), "expired");
      tokenOverrides = { patient: "RelatedPerson/parent" };
      returned(await callback(await begin()), "failed");
      assert.equal(requests.length, 1, "invalid patient does not reach FHIR");
      assert.equal((await sql("SELECT * FROM maple_epic_attempts")).length, 0);
      assert.equal((await sql("SELECT * FROM maple_epic_pending")).length, 0);
    });

    await check("proxy identity never replaces token.patient; patient confirmation gates clinical reads", async () => {
      await connect();
      assert.ok(requests[1].url.endsWith("/Patient/synthetic-child"));
      const status = await getStatus();
      assert.equal(status.pending?.stage, "patient");
      assert.equal(status.pending?.patient.name, "Juniper Test");
      assert.equal(status.pending?.matchesBirthDate, true);
      assert.ok(!JSON.stringify(status).includes("synthetic-access-token"));
      assert.ok(!JSON.stringify(await sql("SELECT * FROM maple_epic_pending")).includes("synthetic-access-token"));
      await expectCode(await flow.review(await reviewRequest({})), 400, "confirmation");
      await expectCode(await flow.importSelected(await importRequest({ shareWithFamilyAndAssistants: true, measurementIds: ["weight-1"] })), 409, "expired");
      assert.equal(requests.length, 2);
    });

    await check("a different child's birth date prevents review and import", async () => {
      birthDate = "2026-10-14";
      await connect();
      assert.equal((await getStatus()).pending?.matchesBirthDate, false);
      await expectCode(await flow.review(await reviewRequest({ confirmPatient: true })), 409, "patient_mismatch");
      await expectCode(await flow.importSelected(await importRequest({ shareWithFamilyAndAssistants: true, measurementIds: ["weight-1"] })), 409, "expired");
      assert.equal(requests.length, 2, "mismatched child never reaches growth read");
      assert.equal((await sql("SELECT * FROM maple_epic_imports")).length, 0);
    });

    await check("review excludes pre-birth measurements and import requires explicit sharing and valid selection", async () => {
      observations.push(observation("before-birth", "29463-7", 3.2, "kg", "2026-10-09T12:00:00Z"));
      const status = await reviewed();
      assert.equal(status.pending?.stage, "measurements");
      assert.deepEqual(status.pending?.measurements?.map(m => m.id).sort(), ["length-1", "weight-1"]);
      assert.equal(status.pending?.skipped, 1);
      assert.equal((await sql("SELECT * FROM maple_epic_imports")).length, 0);
      await expectCode(await flow.importSelected(await importRequest({ measurementIds: ["weight-1"] })), 400, "consent");
      await expectCode(await flow.importSelected(await importRequest({ shareWithFamilyAndAssistants: true, measurementIds: ["forged-id"] })), 400, "selection");
      assert.equal((await sql("SELECT * FROM maple_epic_imports")).length, 0);
      const imported = await flow.importSelected(await importRequest({ shareWithFamilyAndAssistants: true, measurementIds: ["weight-1"] }));
      assert.equal(imported.status, 200, await imported.clone().text());
      assert.deepEqual(await imported.json(), { imported: 1, duplicates: 0 });
      const [entry] = await sql("SELECT e.* FROM maple_entries e JOIN maple_epic_imports i ON i.entry_id = e.id");
      assert.equal(Number(entry.family_id), alpha.familyId);
      assert.equal(Number(entry.baby_id), alpha.babyId);
      assert.deepEqual(entry.data, { weight_g: 3500, at: "doctor" });
      assert.ok(!JSON.stringify(entry).includes(patientId), "no medical record identifier in shared entry");
      assert.equal((await getStatus()).pending, null);
      await expectCode(await flow.importSelected(await importRequest({ shareWithFamilyAndAssistants: true, measurementIds: ["weight-1"] })), 409, "expired");
    });

    await check("birth-date changes after review block the final import", async () => {
      await reviewed();
      await sql("UPDATE maple_babies SET born_at = '2026-10-11T08:00:00Z' WHERE id = $1", [alpha.babyId]);
      await expectCode(await flow.importSelected(await importRequest({ shareWithFamilyAndAssistants: true, measurementIds: ["weight-1"] })), 409, "patient_mismatch");
      assert.equal((await sql("SELECT * FROM maple_epic_imports")).length, 0);
    });

    await check("sandbox allows preview but never writes test measurements to a family log", async () => {
      process.env.MAPLE_EPIC_ENVIRONMENT = "sandbox";
      birthDate = "2000-01-01";
      const status = await reviewed();
      assert.equal(status.pending?.stage, "measurements");
      await expectCode(await flow.importSelected(await importRequest({ shareWithFamilyAndAssistants: true, measurementIds: ["weight-1"] })), 400, "sandbox");
      assert.equal((await sql("SELECT * FROM maple_epic_imports")).length, 0);
    });

    await check("discard and expiration erase the staged review", async () => {
      await connect();
      await sql("UPDATE maple_epic_pending SET expires_at = NOW() - INTERVAL '1 second'");
      assert.equal((await getStatus()).pending, null);
      assert.equal((await sql("SELECT * FROM maple_epic_pending")).length, 0);
      await connect();
      assert.equal((await flow.discard(await discardRequest())).status, 200);
      assert.equal((await sql("SELECT * FROM maple_epic_pending")).length, 0);
      assert.equal((await sql("SELECT * FROM maple_epic_attempts")).length, 0);
    });

    await check("a stale review ID cannot confirm, import or discard a newer connection", async () => {
      const first = await reviewed();
      const staleId = first.pending!.id;
      const second = await reviewed();
      const currentId = second.pending!.id;
      assert.notEqual(staleId, currentId);
      await expectCode(await flow.review(await reviewRequest({ pendingId: staleId, confirmPatient: true })), 409, "expired");
      await expectCode(await flow.importSelected(await importRequest({ pendingId: staleId, shareWithFamilyAndAssistants: true, measurementIds: ["weight-1"] })), 409, "expired");
      const discarded = await flow.discard(request("", "DELETE", { pendingId: staleId }));
      assert.ok(discarded.status === 200 || discarded.status === 409, "stale discard is harmless or rejected");
      assert.equal((await getStatus()).pending?.id, currentId);
      assert.equal((await sql("SELECT * FROM maple_epic_imports")).length, 0);
      await expectCode(await flow.review(request("/review", "POST", { confirmPatient: true })), 409, "expired");
      await expectCode(await flow.discard(request("", "DELETE", {})), 400, "review");
    });

    await check("token parser rejects unsafe bearer data and never forwards raw provider errors", async () => {
      for (const bad of [{ access_token: "bad\r\nheader" }, { expires_in: "600" }, { token_type: "Basic" }, { patient: "" }]) {
        tokenOverrides = bad;
        await assert.rejects(oauth.exchangeCode(config.epicConfig()!, "synthetic-code", crypto.randomToken()), error =>
          error instanceof oauth.EpicOAuthError && error.message === "epic_authorization_failed");
      }
    });
    done("maple-epic-flow");
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Epic flow checks failed");
  process.exitCode = 1;
});
