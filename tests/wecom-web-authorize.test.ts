import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { bootstrap } from "../src/identity.js";

const PAGE = "https://aihub.example.test/remote/v4?backend=uwork";

async function fixture(
  t: TestContext,
  configured: boolean,
  tenantHosts: Record<string, string> = {},
  extraTenant = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-wecom-web-"));
  const app = await createApp({
    database: join(directory, "web.sqlite"),
    masterKey: randomBytes(32),
    publicUrl: "http://localhost:3000",
    worker: false,
    tenantHosts,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = await bootstrap(app.services.db, {
    name: "Web authorize",
    email: "web-authorize@example.test",
    password: "Synthetic-web-authorize-password!",
  });
  if (configured)
    app.services.db.run(
      "INSERT INTO enterprise_auth VALUES(?,?,?,?)",
      owner.tenantId,
      "ww-configured",
      "1000001",
      "credential-fixture",
    );
  let otherTenantId: string | undefined;
  if (extraTenant) {
    otherTenantId = "tenant-other-fixture";
    app.services.db.run(
      "INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)",
      otherTenantId,
      "Other tenant",
      Date.now(),
    );
    app.services.db.run(
      "INSERT INTO enterprise_auth VALUES(?,?,?,?)",
      otherTenantId,
      "ww-other",
      "1000002",
      "credential-fixture-2",
    );
  }
  return { app, owner, otherTenantId };
}

const attempt = (app: { inject: (o: unknown) => Promise<{ json: () => unknown }> }, tenantId: string, body: unknown) =>
  app.inject({
    method: "POST",
    url: "/api/auth/wecom/attempts",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ tenantId, ...(body as object) }),
  }) as Promise<{
    statusCode: number;
    json: () => { id: string; proof: string; authorizeUrl: string };
  }>;

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

test("web mode binds a snsapi_base authorization that returns to the phone page", async (t) => {
  const f = await fixture(t, true);
  const response = await attempt(f.app, f.owner.tenantId, { mode: "web", returnTo: PAGE });
  assert.equal(response.statusCode, 201);
  const payload = response.json();
  const url = new URL(payload.authorizeUrl);
  assert.equal(url.origin, "https://open.weixin.qq.com");
  assert.equal(url.pathname, "/connect/oauth2/authorize");
  assert.equal(url.searchParams.get("appid"), "ww-configured");
  assert.equal(url.searchParams.get("scope"), "snsapi_base");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), payload.id);
  assert.equal(url.searchParams.get("redirect_uri"), PAGE);
  assert.equal(url.hash, "#wechat_redirect");
});

test("qr mode keeps the existing scan-login page and default mode is qr", async (t) => {
  const f = await fixture(t, true);
  for (const body of [{ mode: "qr" }, {}]) {
    const response = await attempt(f.app, f.owner.tenantId, body);
    assert.equal(response.statusCode, 201);
    const url = new URL(response.json().authorizeUrl);
    assert.equal(url.origin, "https://login.work.weixin.qq.com");
    assert.equal(url.searchParams.get("login_type"), "CorpApp");
  }
});

test("a return target that is not HTTPS (or loopback) is rejected", async (t) => {
  const f = await fixture(t, true);
  for (const returnTo of ["http://aihub.example.test/remote/v4", "https://user:pass@a.test/x"]) {
    const response = await attempt(f.app, f.owner.tenantId, { mode: "web", returnTo });
    assert.equal(response.statusCode, 400);
  }
});

test("the local synthetic login keeps working in web mode and hands the code back to the page", async (t) => {
  const f = await fixture(t, false);
  await withEnv("web-authorize@example.test", async () => {
    const response = await attempt(f.app, f.owner.tenantId, {
      mode: "web",
      returnTo: "http://localhost:5174/remote/v4?backend=uwork",
    });
    assert.equal(response.statusCode, 201);
    const payload = response.json();
    const authorize = new URL(payload.authorizeUrl);
    assert.equal(authorize.pathname, "/api/auth/wecom/dev-synthetic");
    assert.equal(authorize.searchParams.get("return_to"), "http://localhost:5174/remote/v4?backend=uwork");

    const redirected = await f.app.inject({
      method: "GET",
      url: authorize.pathname + authorize.search,
    });
    assert.equal(redirected.statusCode, 302);
    const callback = new URL(redirected.headers.location as string);
    assert.equal(callback.pathname, "/api/auth/wecom/callback");
    assert.equal(callback.searchParams.get("state"), payload.id);

    const completed = await f.app.inject({
      method: "GET",
      url: callback.pathname + callback.search,
    });
    assert.equal(completed.statusCode, 302);
    const back = new URL(completed.headers.location as string);
    assert.equal(back.origin, "http://localhost:5174");
    assert.equal(back.searchParams.get("state"), payload.id);
    assert.equal(back.searchParams.get("code"), "dev-synthetic");
  });
});

/** 先建库写种子，再以指定 host 映射重开实例（组织解析发生在路由闭包里，必须构造时给）。 */
async function seededApp(
  t: TestContext,
  seed: (db: import("../src/db.js").Db) => void,
  tenantHosts: Record<string, string> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "uwork-wecom-host-"));
  const database = join(directory, "host.sqlite");
  const masterKey = randomBytes(32);
  const first = await createApp({ database, masterKey, publicUrl: "http://localhost:3000", worker: false });
  seed(first.services.db);
  await first.close();
  const app = await createApp({
    database,
    masterKey,
    publicUrl: "http://localhost:3000",
    worker: false,
    tenantHosts,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return app;
}

const seedTenant = (
  db: import("../src/db.js").Db,
  id: string,
  corpId: string,
) => {
  db.run("INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)", id, id, Date.now());
  db.run("INSERT INTO enterprise_auth VALUES(?,?,?,?)", id, corpId, "1000001", `credential-${id}`);
};

test("the same-origin entry resolves the tenant from the request host", async (t) => {
  const app = await seededApp(
    t,
    (db) => {
      seedTenant(db, "tenant-mapped", "ww-mapped");
      seedTenant(db, "tenant-other", "ww-other");
    },
    { "uwork.example.test": "tenant-mapped" },
  );
  const webConfig = await app.inject({
    method: "GET",
    url: "/api/auth/wecom/web-config",
    headers: { host: "uwork.example.test" },
  });
  assert.equal(webConfig.statusCode, 200);
  assert.deepEqual(webConfig.json(), { backend: "uwork", tenantId: "tenant-mapped" });

  const attempts = await app.inject({
    method: "POST",
    url: "/api/auth/wecom/attempts",
    headers: { "content-type": "application/json", host: "uwork.example.test" },
    payload: JSON.stringify({ mode: "web", returnTo: "https://aihub.example.test/remote/v4" }),
  });
  assert.equal(attempts.statusCode, 201);
  const authorize = new URL((attempts.json() as { authorizeUrl: string }).authorizeUrl);
  assert.equal(authorize.searchParams.get("appid"), "ww-mapped");

  // 未映射的 Host + 多个已配置租户：不猜组织，明确拒绝。
  const ambiguousConfig = await app.inject({
    method: "GET",
    url: "/api/auth/wecom/web-config",
    headers: { host: "unknown.example.test" },
  });
  assert.equal(ambiguousConfig.statusCode, 404);
  const ambiguousAttempts = await app.inject({
    method: "POST",
    url: "/api/auth/wecom/attempts",
    headers: { "content-type": "application/json", host: "unknown.example.test" },
    payload: JSON.stringify({}),
  });
  assert.equal(ambiguousAttempts.statusCode, 400);
  assert.equal(
    (ambiguousAttempts.json() as { error: { code: string } }).error.code,
    "TENANT_REQUIRED",
  );
});

test("a single configured tenant is used without any host mapping", async (t) => {
  const app = await seededApp(t, (db) => seedTenant(db, "tenant-only", "ww-only"));
  const webConfig = await app.inject({
    method: "GET",
    url: "/api/auth/wecom/web-config",
    headers: { host: "whatever.example.test" },
  });
  assert.equal(webConfig.statusCode, 200);
  assert.deepEqual(webConfig.json(), { backend: "uwork", tenantId: "tenant-only" });
  const attempts = await app.inject({
    method: "POST",
    url: "/api/auth/wecom/attempts",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({}),
  });
  assert.equal(attempts.statusCode, 201);
  assert.equal(
    new URL((attempts.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("appid"),
    "ww-only",
  );
});
