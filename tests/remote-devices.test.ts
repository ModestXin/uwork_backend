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

async function fixture(
  t: TestContext,
  options: {
    verifyExternalToken?: (token: string) => Promise<{ wecomUserId: string; orgId: string } | null>;
    bindExternalId?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-remote-devices-"));
  const app = await createApp({
    database: join(directory, "remote.sqlite"),
    masterKey: randomBytes(32),
    publicUrl: "http://localhost:3000",
    worker: false,
    ...(options.verifyExternalToken ? { verifyExternalToken: options.verifyExternalToken } : {}),
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
  if (options.bindExternalId)
    app.services.db.run(
      "UPDATE members SET external_id=? WHERE tenant_id=? AND user_id=?",
      options.bindExternalId,
      owner.tenantId,
      owner.userId,
    );
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
  const registeredBody = registered.json() as { ok: boolean; tenantId?: string; memberId?: string };
  // 桌面据此记住"我是谁"，手机身份帧要跟它比对。
  assert.equal(registeredBody.memberId, f.owner.userId);
  assert.equal(registeredBody.tenantId, f.owner.tenantId);
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

test("a desktop signed in through pivot (no backend session) is mapped by WeCom user id", async (t) => {
  const f = await fixture(t, {
    bindExternalId: "xiaohua.xin",
    verifyExternalToken: async (token) =>
      token === "pivot-token" ? { wecomUserId: "xiaohua.xin", orgId: "pivot-org" } : null,
  });
  // 桌面只带 pivot 令牌，没有本后台会话。
  const registered = await f.app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { authorization: "Bearer pivot-token", "content-type": "application/json" },
    payload: body({ deviceMid: "mid-desktop", name: "桌面（pivot 登录）", platform: "darwin" }),
  });
  assert.equal(registered.statusCode, 200);
  // 手机（本后台会话，同一企微身份）能看到它，并完成配对。
  const listed = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-devices",
    headers: auth(f.ownerToken),
  });
  assert.equal((listed.json() as { devices: Array<{ name?: string }> }).devices[0]?.name, "桌面（pivot 登录）");
  const pairing = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-devices/${SID}/pairings`,
    headers: auth(f.ownerToken),
  });
  assert.equal(pairing.statusCode, 201);
  const pairingId = (pairing.json() as { id: string }).id;
  const next = await f.app.inject({
    method: "GET",
    url: `/api/client/remote-pairings/next?deviceSid=${SID}&wait=0`,
    headers: { authorization: "Bearer pivot-token" },
  });
  assert.equal(next.statusCode, 200);
  assert.equal((next.json() as { pairing: { id: string } | null }).pairing?.id, pairingId);
  const answered = await f.app.inject({
    method: "POST",
    url: `/api/client/remote-pairings/${pairingId}/answer`,
    headers: { authorization: "Bearer pivot-token", "content-type": "application/json" },
    payload: JSON.stringify({ sid: SID, hash: "pairing-hash-fixture-0001" }),
  });
  assert.equal(answered.statusCode, 200);
});

test("an unknown pivot token or an unmapped member is refused", async (t) => {
  const f = await fixture(t, {
    bindExternalId: "xiaohua.xin",
    verifyExternalToken: async (token) =>
      token === "pivot-token" ? { wecomUserId: "someone.else", orgId: "pivot-org" } : null,
  });
  const badToken = await f.app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { authorization: "Bearer nope", "content-type": "application/json" },
    payload: body({ deviceMid: "mid-1" }),
  });
  assert.equal(badToken.statusCode, 401);
  const unmapped = await f.app.inject({
    method: "PUT",
    url: `/api/client/remote-devices/${SID}`,
    headers: { authorization: "Bearer pivot-token", "content-type": "application/json" },
    payload: body({ deviceMid: "mid-1" }),
  });
  assert.equal(unmapped.statusCode, 403);
});

test("the identity endpoint answers member and tenant for both the phone and the pivot-bound desktop", async (t) => {
  const f = await fixture(t, {
    bindExternalId: "xiaohua.xin",
    verifyExternalToken: async (token) =>
      token === "pivot-token" ? { wecomUserId: "xiaohua.xin", orgId: "pivot-org" } : null,
  });
  const phone = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-identity",
    headers: auth(f.ownerToken),
  });
  assert.equal(phone.statusCode, 200);
  assert.deepEqual(
    { tenantId: (phone.json() as { tenantId: string }).tenantId, memberId: (phone.json() as { memberId: string }).memberId },
    { tenantId: f.owner.tenantId, memberId: f.owner.userId },
  );
  const desktop = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-identity",
    headers: { authorization: "Bearer pivot-token" },
  });
  assert.equal(desktop.statusCode, 200);
  // 两条通道最终落到同一个成员实体，"同一个人"是可判定的。
  assert.deepEqual(
    { tenantId: (desktop.json() as { tenantId: string }).tenantId, memberId: (desktop.json() as { memberId: string }).memberId },
    { tenantId: (phone.json() as { tenantId: string }).tenantId, memberId: (phone.json() as { memberId: string }).memberId },
  );
  const other = await f.app.inject({
    method: "GET",
    url: "/api/client/remote-identity",
    headers: { authorization: "Bearer nope" },
  });
  assert.equal(other.statusCode, 401);
});
