import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { bootstrap, issueSession } from "../src/identity.js";

const SID = "device-sid-fixture-0001";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-remote-devices-"));
  const app = await createApp({
    database: join(directory, "remote.sqlite"),
    masterKey: randomBytes(32),
    publicUrl: "http://localhost:3000",
    worker: false,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = await bootstrap(app.services.db, {
    name: "Remote owner",
    email: "remote-owner@example.test",
    password: "Synthetic-remote-owner-password!",
  });
  const other = app.services.db.transaction(() => {
    const userId = "user-other-fixture";
    app.services.db.run(
      "INSERT INTO users VALUES(?,?,?,?,?)",
      userId,
      "remote-other@example.test",
      "Remote other",
      "not-a-real-digest",
      Date.now(),
    );
    app.services.db.run(
      "INSERT INTO members(tenant_id,user_id,role,seat) VALUES(?,?,?,1)",
      owner.tenantId,
      userId,
      "member",
    );
    return { userId, token: issueSession(app.services.db, userId, owner.tenantId).token };
  });
  const ownerToken = issueSession(app.services.db, owner.userId, owner.tenantId).token;
  return { app, owner, ownerToken, other };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const body = (value: unknown) => JSON.stringify(value);

test("desktop registers, heartbeats and unregisters a device without storing secrets", async (t) => {
  const f = await fixture(t);
  const registered = await f.app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { ...auth(f.ownerToken), "content-type": "application/json" },
    payload: body({ deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" }),
  });
  assert.equal(registered.statusCode, 200);
  const listed = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-devices",
    headers: auth(f.ownerToken),
  });
  assert.equal(listed.statusCode, 200);
  const devices = (listed.json() as { devices: Record<string, unknown>[] }).devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.deviceSid, SID);
  assert.equal(devices[0]!.name, "办公室 Mac");
  // 列表不带任何密钥/凭据字段。
  assert.deepEqual(
    Object.keys(devices[0]!).sort(),
    ["deviceMid", "deviceSid", "expiresAt", "name", "platform", "updatedAt"],
  );

  // 心跳续期：把过期时间推到过去后再次 PUT，应当重新可见。
  f.app.services.db.run("UPDATE remote_devices SET expires_at=? WHERE device_sid=?", Date.now() - 1, SID);
  const stale = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-devices",
    headers: auth(f.ownerToken),
  });
  assert.equal((stale.json() as { devices: unknown[] }).devices.length, 0);
  await f.app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { ...auth(f.ownerToken), "content-type": "application/json" },
    payload: body({ deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" }),
  });
  const alive = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-devices",
    headers: auth(f.ownerToken),
  });
  assert.equal((alive.json() as { devices: unknown[] }).devices.length, 1);

  const removed = await f.app.inject({
    method: "DELETE",
    url: `/api/client/remote-devices/${SID}`,
    headers: auth(f.ownerToken),
  });
  assert.equal(removed.statusCode, 200);
  const after = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-devices",
    headers: auth(f.ownerToken),
  });
  assert.equal((after.json() as { devices: unknown[] }).devices.length, 0);
});

test("another member of the same tenant sees nothing and cannot act on that device", async (t) => {
  const f = await fixture(t);
  await f.app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { ...auth(f.ownerToken), "content-type": "application/json" },
    payload: body({ deviceMid: "mid-1" }),
  });
  const listed = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-devices",
    headers: auth(f.other.token),
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual((listed.json() as { devices: unknown[] }).devices, []);
  const pairing = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-devices/${SID}/pairings`,
    headers: auth(f.other.token),
  });
  assert.equal(pairing.statusCode, 404);
});

test("device endpoints require a session and reject unknown fields", async (t) => {
  const f = await fixture(t);
  const anonymous = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-devices",
  });
  assert.equal(anonymous.statusCode, 401);
  const extra = await f.app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { ...auth(f.ownerToken), "content-type": "application/json" },
    payload: body({ deviceMid: "mid-1", hash: "should-not-be-accepted" }),
  });
  assert.equal(extra.statusCode, 400);
});
