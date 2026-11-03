import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { bootstrap, issueSession } from "../src/identity.js";

const SID = "device-sid-pairing-0001";
const HASH = "pairing-hash-fixture-0001";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-remote-pairings-"));
  const app = await createApp({
    database: join(directory, "pairings.sqlite"),
    masterKey: randomBytes(32),
    publicUrl: "http://localhost:3000",
    worker: false,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = await bootstrap(app.services.db, {
    name: "Pairing owner",
    email: "pairing-owner@example.test",
    password: "Synthetic-pairing-owner-password!",
  });
  const ownerToken = issueSession(app.services.db, owner.userId, owner.tenantId).token;
  const otherId = "user-pairing-other";
  app.services.db.run(
    "INSERT INTO users VALUES(?,?,?,?,?)",
    otherId,
    "pairing-other@example.test",
    "Pairing other",
    "not-a-real-digest",
    Date.now(),
  );
  app.services.db.run(
    "INSERT INTO members(tenant_id,user_id,role,seat) VALUES(?,?,?,1)",
    owner.tenantId,
    otherId,
    "member",
  );
  const otherToken = issueSession(app.services.db, otherId, owner.tenantId).token;
  await app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    payload: JSON.stringify({ deviceMid: "mid-1", name: "办公室 Mac" }),
  });
  return { app, owner, ownerToken, otherToken };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("a pairing request is answered once and the material is consumed on read", async (t) => {
  const f = await fixture(t);
  const created = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-devices/${SID}/pairings`,
    headers: auth(f.ownerToken),
  });
  assert.equal(created.statusCode, 201);
  const pairingId = (created.json() as { id: string }).id;

  // 桌面长轮询取到这条请求（wait=0 不等待）。
  const next = await f.app.inject({
    method: "GET",
    url: `/api/client/remote-pairings/next?deviceSid=${SID}&wait=0`,
    headers: auth(f.ownerToken),
  });
  assert.equal(next.statusCode, 200);
  assert.equal((next.json() as { pairing: { id: string } | null }).pairing?.id, pairingId);

  const answered = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-pairings/${pairingId}/answer`,
    headers: { ...auth(f.ownerToken), "content-type": "application/json" },
    payload: JSON.stringify({ sid: SID, hash: HASH }),
  });
  assert.equal(answered.statusCode, 200);

  const polled = await f.app.inject({
    method: "GET",
    url: `/api/client/remote-devices/${SID}/pairings/${pairingId}`,
    headers: auth(f.ownerToken),
  });
  assert.equal(polled.statusCode, 200);
  const payload = polled.json() as {
    status: string;
    pairing?: { sid: string; hash: string; org: string; enterpriseAuth: string };
  };
  assert.equal(payload.status, "answered");
  assert.deepEqual(payload.pairing, {
    sid: SID,
    hash: HASH,
    org: f.owner.tenantId,
    enterpriseAuth: "http://localhost:3000",
  });

  // 一次性：第二次读只能拿到 expired。
  const again = await f.app.inject({
    method: "GET",
    url: `/api/client/remote-devices/${SID}/pairings/${pairingId}`,
    headers: auth(f.ownerToken),
  });
  assert.equal((again.json() as { status: string }).status, "expired");
});

test("pending requests expire and cannot be answered afterwards", async (t) => {
  const f = await fixture(t);
  const created = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-devices/${SID}/pairings`,
    headers: auth(f.ownerToken),
  });
  const pairingId = (created.json() as { id: string }).id;
  f.app.services.db.run(
    "UPDATE remote_pairings SET expires_at=? WHERE id=?",
    Date.now() - 1,
    pairingId,
  );
  const expired = await f.app.inject({
    method: "GET",
    url: `/api/client/remote-devices/${SID}/pairings/${pairingId}`,
    headers: auth(f.ownerToken),
  });
  assert.equal((expired.json() as { status: string }).status, "expired");
  const answered = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-pairings/${pairingId}/answer`,
    headers: { ...auth(f.ownerToken), "content-type": "application/json" },
    payload: JSON.stringify({ sid: SID, hash: HASH }),
  });
  assert.equal(answered.statusCode, 409);
});

test("another member cannot see or answer someone else's pairing", async (t) => {
  const f = await fixture(t);
  const created = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-devices/${SID}/pairings`,
    headers: auth(f.ownerToken),
  });
  const pairingId = (created.json() as { id: string }).id;

  const next = await f.app.inject({
    method: "GET",
    url: `/api/client/remote-pairings/next?deviceSid=${SID}&wait=0`,
    headers: auth(f.otherToken),
  });
  assert.equal(next.statusCode, 200);
  assert.equal((next.json() as { pairing: unknown }).pairing, null);

  const answer = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-pairings/${pairingId}/answer`,
    headers: { ...auth(f.otherToken), "content-type": "application/json" },
    payload: JSON.stringify({ sid: SID, hash: HASH }),
  });
  assert.equal(answer.statusCode, 404);

  const poll = await f.app.inject({
    method: "GET",
    url: `/api/client/remote-devices/${SID}/pairings/${pairingId}`,
    headers: auth(f.otherToken),
  });
  assert.equal(poll.statusCode, 404);
});

test("the hash shape is validated before it is handed to the phone", async (t) => {
  const f = await fixture(t);
  const created = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-devices/${SID}/pairings`,
    headers: auth(f.ownerToken),
  });
  const pairingId = (created.json() as { id: string }).id;
  for (const payload of [
    { sid: SID, hash: "short" },
    { sid: SID, hash: "has space and is long enough" },
    { sid: "another-device-sid", hash: HASH },
  ]) {
    const answer = await f.app.inject({
      method: "POST",
      url: `/api/client/remote-pairings/${pairingId}/answer`,
      headers: { ...auth(f.ownerToken), "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    assert.equal(answer.statusCode, 400);
  }
});
