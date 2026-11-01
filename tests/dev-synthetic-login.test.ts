import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { bootstrap } from "../src/identity.js";

const EMAIL = "dev-login-owner@example.test";

async function fixture(t: TestContext, publicUrl = "http://localhost:3000") {
  const directory = await mkdtemp(join(tmpdir(), "uwork-dev-login-"));
  const app = await createApp({
    database: join(directory, "dev-login.sqlite"),
    masterKey: randomBytes(32),
    publicUrl,
    worker: false,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = await bootstrap(app.services.db, {
    name: "Dev login",
    email: EMAIL,
    password: "Synthetic-dev-login-password!",
  });
  return { app, owner, publicUrl };
}

const withEnv = async <T>(value: string | undefined, run: () => Promise<T>): Promise<T> => {
  const previous = process.env.UWORK_DEV_SYNTHETIC_LOGIN;
  if (value === undefined) delete process.env.UWORK_DEV_SYNTHETIC_LOGIN;
  else process.env.UWORK_DEV_SYNTHETIC_LOGIN = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.UWORK_DEV_SYNTHETIC_LOGIN;
    else process.env.UWORK_DEV_SYNTHETIC_LOGIN = previous;
  }
};

test("synthetic login stays disabled without the env flag or outside loopback", async (t) => {
  const { app, owner } = await fixture(t);
  await withEnv(undefined, async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/wecom/attempts",
      payload: { tenantId: owner.tenantId },
    });
    assert.equal(response.statusCode, 503);
  });
  // 非回环地址即使打开开关也不生效，避免把它带进任何真实部署。
  await withEnv(EMAIL, async () => {
    const https = await fixture(t, "https://auth.example.test");
    const response = await https.app.inject({
      method: "POST",
      url: "/api/auth/wecom/attempts",
      payload: { tenantId: https.owner.tenantId },
    });
    assert.equal(response.statusCode, 503);
  });
});

test("a loopback tenant can complete the whole synthetic login over the real routes", async (t) => {
  const { app, owner, publicUrl } = await fixture(t);
  await withEnv(EMAIL, async () => {
    const attempts = await app.inject({
      method: "POST",
      url: "/api/auth/wecom/attempts",
      payload: { tenantId: owner.tenantId },
    });
    assert.equal(attempts.statusCode, 201);
    const attempt = attempts.json() as { id: string; proof: string; authorizeUrl: string };
    const authorize = new URL(attempt.authorizeUrl);
    assert.equal(authorize.origin, publicUrl);
    assert.equal(authorize.pathname, "/api/auth/wecom/dev-synthetic");
    assert.equal(authorize.searchParams.get("state"), attempt.id);

    const authorized = await app.inject({ method: "GET", url: authorize.pathname + authorize.search });
    assert.equal(authorized.statusCode, 302);
    const callback = new URL(authorized.headers.location as string);
    assert.equal(callback.pathname, "/api/auth/wecom/callback");
    assert.equal(callback.searchParams.get("state"), attempt.id);
    assert.equal(callback.searchParams.get("code"), "dev-synthetic");

    const complete = await app.inject({
      method: "POST",
      url: `/api/auth/wecom/attempts/${attempt.id}/complete`,
      payload: { proof: attempt.proof, code: "dev-synthetic" },
    });
    assert.equal(complete.statusCode, 200);
    const claim = await app.inject({
      method: "POST",
      url: `/api/auth/wecom/attempts/${attempt.id}/claim`,
      payload: { proof: attempt.proof, delivery: "token" },
    });
    assert.equal(claim.statusCode, 200);
    assert.equal((claim.json() as { status: string }).status, "authorized");

    const token = (claim.json() as { token: string }).token;
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.statusCode, 200);
    const body = me.json() as { user: { email: string }; membership: { externalId: string | null } };
    assert.equal(body.user.email, EMAIL);
    assert.equal(body.membership.externalId, `dev-synthetic:${EMAIL}`);

    // 合成登录不产生任何企微网络调用：第二次尝试仍然走本机授权页。
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/wecom/attempts",
      payload: { tenantId: owner.tenantId },
    });
    assert.equal(again.statusCode, 201);
    assert.equal(
      new URL((again.json() as { authorizeUrl: string }).authorizeUrl).pathname,
      "/api/auth/wecom/dev-synthetic",
    );
  });
});

test("a tenant with a configured WeCom app still binds the real authorization URL", async (t) => {
  const { app, owner } = await fixture(t);
  app.services.db.run(
    "INSERT INTO enterprise_auth VALUES(?,?,?,?)",
    owner.tenantId,
    "ww-configured",
    "1000001",
    "credential-fixture",
  );
  await withEnv(EMAIL, async () => {
    const attempts = await app.inject({
      method: "POST",
      url: "/api/auth/wecom/attempts",
      payload: { tenantId: owner.tenantId },
    });
    assert.equal(attempts.statusCode, 201);
    const url = new URL((attempts.json() as { authorizeUrl: string }).authorizeUrl);
    assert.equal(url.origin, "https://login.work.weixin.qq.com");
    assert.equal(url.searchParams.get("appid"), "ww-configured");
  });
});
