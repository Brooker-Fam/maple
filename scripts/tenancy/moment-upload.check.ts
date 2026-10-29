import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NextRequest } from "next/server";
import { workAsyncStorage, type WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import { done, freshDb, seedFamilies, sql, test } from "./harness";
import { sealSession } from "../../src/lib/maple/auth";
import { DELETE, GET, POST } from "../../src/app/api/maple/upload/route";
import { GET as photoGET } from "../../src/app/api/maple/photo/route";
import { claimUpload, FAMILY_UPLOAD_LIMITS } from "../../src/lib/maple/upload-quota";
import { encodeForUpload, getUploadMode, uploadPhoto } from "../../src/lib/maple/image";

process.env.GOOGLE_CLIENT_SECRET = "synthetic-moment-upload-check";
process.env.MAPLE_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_madeupstore_notarealsecret0123456789";
delete process.env.MAPLE_SESSION_SECRET;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

async function main() {
  await freshDb({ shape: "final" });
  const { beta } = await seedFamilies();
  const cookie = `maple_session=${encodeURIComponent(sealSession(beta.member, beta.familyId))}`;
  const attempts: { path: string; family: string | null; status: number }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/api/blob/delete") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "forbidden", message: "synthetic Blob refusal" } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const request = new NextRequest(`http://localhost:3000${req.url}`, {
      method: req.method,
      ...(raw ? { body: raw } : {}),
      headers: { cookie, "content-type": "application/json", "x-real-ip": "203.0.113.23", ...(req.headers["x-maple-family"] ? { "x-maple-family": String(req.headers["x-maple-family"]) } : {}) },
    });
    const response = req.method === "POST" ? await POST(request) : await GET(request);
    const body = await response.json();
    if (req.method === "POST") {
      attempts.push({ path: JSON.parse(raw).payload.pathname, family: request.headers.get("x-maple-family"), status: response.status });
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Synthetic test stops before the Blob upload" }));
    } else res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Object.assign(globalThis, { location: { href: `${origin}/maple` } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => originalFetch(new URL(String(input), origin), init);
  const request = (method = "GET", body?: unknown) => new NextRequest(`${origin}/api/maple/upload`, {
    method, headers: { cookie, "content-type": "application/json", "x-maple-family": "2" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const validTokenRequest = { type: "blob.generate-client-token", payload: { pathname: "maple/f2/moments/synthetic-alert.jpg", clientPayload: JSON.stringify({ access: "private" }), multipart: false } };
  async function signals(run: () => Promise<Response[]>) {
    const tasks: (() => Promise<unknown>)[] = [];
    const emails: { to: string; subject: string; text: string }[] = [];
    const saved = Object.fromEntries(["RESEND_API_KEY", "RESEND_EMAIL_DOMAIN", "MAPLE_ALERT_EMAIL", "MAPLE_ANALYTICS_TEST"].map(key => [key, process.env[key]]));
    process.env.RESEND_API_KEY = "re_synthetic_alert_check";
    process.env.RESEND_EMAIL_DOMAIN = "example.test";
    process.env.MAPLE_ALERT_EMAIL = "synthetic-operator@example.test";
    delete process.env.MAPLE_ANALYTICS_TEST;
    await sql("DELETE FROM maple_usage_alerts");
    const previousFetch = globalThis.fetch;
    const previousError = console.error;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.resend.com/emails");
      emails.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "synthetic-alert-email" });
    };
    console.error = () => {};
    try {
      const work = { afterContext: { after: (task: () => Promise<unknown>) => tasks.push(task) } } as unknown as WorkStore;
      const responses = await workAsyncStorage.run(work, run);
      for (const task of tasks) await task();
      return { responses, emails };
    } finally {
      globalThis.fetch = previousFetch;
      console.error = previousError;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  try {
    await test("the browser uploader uses the server's family prefix and binds token requests to that family", async () => {
      await getUploadMode(true);
      await assert.rejects(uploadPhoto({ full: new Blob(["synthetic bytes"], { type: "image/jpeg" }), thumb: null, contentType: "image/jpeg" }, { familyId: beta.familyId } as Parameters<typeof uploadPhoto>[1]));
      assert.equal(attempts.length, 3);
      assert.ok(attempts.every(attempt => attempt.path.startsWith("maple/f2/moments/") && attempt.family === "2" && attempt.status === 200), JSON.stringify(attempts));
    });

    await test("upload handshakes refuse a stale family's request after a family switch", async () => {
      const request = new NextRequest(`${origin}/api/maple/upload`, { headers: { cookie, "x-maple-family": "1" } });
      const response = await GET(request);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "family_mismatch");
    });

    await test("undecodable images are refused instead of uploading original bytes", async () => {
      const input = new File(["synthetic malformed JPEG"], "synthetic.jpg", { type: "image/jpeg" });
      await assert.rejects(encodeForUpload(input), /open|prepare/i);
    });

    await test("unexpected token failures return 500 and alert the operator while invalid submissions do not", async () => {
      const token = process.env.MAPLE_BLOB_READ_WRITE_TOKEN;
      process.env.MAPLE_BLOB_READ_WRITE_TOKEN = "synthetic-invalid-token";
      try {
        const result = await signals(async () => [
          await POST(request("POST", validTokenRequest)),
          await POST(request("POST", { type: "blob.generate-client-token" })),
          await POST(request("POST", { ...validTokenRequest, payload: { ...validTokenRequest.payload, pathname: "other/path.jpg" } })),
        ]);
        assert.deepEqual(result.responses.map(response => response.status), [500, 400, 400]);
        assert.equal(result.emails.length, 1);
        assert.equal(result.emails[0].to, "synthetic-operator@example.test");
        assert.ok(!JSON.stringify(result.emails).includes("synthetic-invalid-token"));
      } finally {
        process.env.MAPLE_BLOB_READ_WRITE_TOKEN = token;
      }
    });

    await test("missing required photo storage reports 503 and sends one operator alert across upload and reads", async () => {
      const token = process.env.MAPLE_BLOB_READ_WRITE_TOKEN;
      delete process.env.MAPLE_BLOB_READ_WRITE_TOKEN;
      const [entry] = await sql("INSERT INTO maple_entries (family_id,baby_id,kind,started_at,data,created_by) VALUES ($1,$2,'moment',NOW(),$3,$4) RETURNING id", [beta.familyId, beta.babyId, { photos: [{ key: "https://synthetic.private.blob.vercel-storage.com/maple/f2/moments/synthetic-alert.jpg", access: "private" }] }, beta.member]);
      try {
        const result = await signals(async () => [
          await GET(request()),
          await POST(request("POST", validTokenRequest)),
          await photoGET(new NextRequest(`${origin}/api/maple/photo?entry=${entry.id}`, { headers: { cookie } })),
        ]);
        assert.deepEqual(result.responses.map(response => response.status), [503, 503, 503]);
        assert.equal(result.emails.length, 1);
        assert.equal(result.emails[0].to, "synthetic-operator@example.test");
      } finally {
        process.env.MAPLE_BLOB_READ_WRITE_TOKEN = token;
      }
    });

    await test("failed orphan cleanup reports an operator alert without claiming deletion succeeded", async () => {
      process.env.VERCEL_BLOB_API_URL = `${origin}/api/blob`;
      try {
        const result = await signals(async () => [await DELETE(request("DELETE", { urls: ["https://synthetic.private.blob.vercel-storage.com/maple/f2/moments/synthetic-orphan.jpg"] }))]);
        assert.equal(result.responses[0].status, 500);
        assert.equal(result.emails.length, 1);
        assert.equal(result.emails[0].to, "synthetic-operator@example.test");
      } finally {
        delete process.env.VERCEL_BLOB_API_URL;
      }
    });

    await test("an upload quota database failure is an alerted 503, while exhausted quota stays 429", async () => {
      await sql("ALTER TABLE maple_upload_counts RENAME TO synthetic_unavailable_upload_counts");
      let failure: Awaited<ReturnType<typeof signals>>;
      try {
        failure = await signals(async () => [await POST(request("POST", validTokenRequest))]);
      } finally {
        await sql("ALTER TABLE synthetic_unavailable_upload_counts RENAME TO maple_upload_counts");
      }
      assert.equal(failure.responses[0].status, 503);
      assert.equal(failure.emails.length, 1);
      assert.equal(failure.emails[0].subject, "Maple database unavailable");
      await sql("UPDATE maple_upload_counts SET tokens = $1 WHERE family_id = 2 AND day = CURRENT_DATE", [FAMILY_UPLOAD_LIMITS.tokensPerDay]);
      const exhausted = await signals(async () => [await POST(request("POST", validTokenRequest))]);
      assert.equal(exhausted.responses[0].status, 429);
      assert.equal(exhausted.emails.length, 0);
    });

    await test("a missing database cannot masquerade as exhausted upload quota", async () => {
      const database = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        await assert.rejects(claimUpload(beta.familyId), /unavailable/i);
      } finally {
        process.env.DATABASE_URL = database;
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  done("moment-upload.check.ts");
}
void main();
