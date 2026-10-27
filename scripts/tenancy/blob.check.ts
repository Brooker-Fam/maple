import assert from "node:assert/strict";
import { blobToken, uploadStore } from "../../src/lib/maple/blob";

delete process.env.MAPLE_BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;

try {
  assert.equal(uploadStore(), null);
  process.env.BLOB_READ_WRITE_TOKEN = "synthetic-public-token";
  assert.equal(uploadStore(), null, "a legacy public token must not enable new uploads");
  assert.equal(blobToken("public"), "synthetic-public-token", "legacy photos still need their public store token");
  process.env.MAPLE_BLOB_READ_WRITE_TOKEN = "synthetic-private-token";
  assert.deepEqual(uploadStore(), { access: "private", token: "synthetic-private-token" });
  process.env.MAPLE_BLOB_READ_WRITE_TOKEN = " ";
  assert.equal(uploadStore(), null, "an empty private token must not fall back to the public store");
  console.log("PASS new uploads require a private store while legacy photos retain their public token");
} finally {
  delete process.env.MAPLE_BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
}
