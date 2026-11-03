import assert from "node:assert/strict";
import test from "node:test";
import { createPivotTokenVerifier } from "../src/pivot-auth.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("maps a pivot session onto its WeCom user id and organization", async () => {
  const calls: Array<{ url: string; authorization?: string; host?: string }> = [];
  const verify = createPivotTokenVerifier({
    baseUrl: "http://127.0.0.1:23080",
    host: "pivot.ucas.com.cn",
    fetchImpl: (async (url: URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({
        url: String(url),
        authorization: headers.authorization,
        host: headers.host,
      });
      return json({ user: { wecom_userid: "xiaohua.xin", org_id: "org-1" } });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await verify("pivot-token"), { wecomUserId: "xiaohua.xin", orgId: "org-1" });
  assert.deepEqual(calls[0], {
    url: "http://127.0.0.1:23080/api/auth/refresh",
    authorization: "Bearer pivot-token",
    host: "pivot.ucas.com.cn",
  });
  // 同一令牌在 TTL 内命中缓存：心跳密集时不会把 pivot 打成风暴。
  await verify("pivot-token");
  assert.equal(calls.length, 1);
});

test("treats rejected and malformed responses as no identity, caching the miss briefly", async () => {
  let calls = 0;
  const verify = createPivotTokenVerifier({
    baseUrl: "http://127.0.0.1:23080",
    host: "pivot.ucas.com.cn",
    warn: () => {},
    fetchImpl: (async () => {
      calls += 1;
      return json({ error: { code: "SESSION_EXPIRED" } }, 401);
    }) as unknown as typeof fetch,
  });
  assert.equal(await verify("bad-token"), null);
  assert.equal(await verify("bad-token"), null);
  assert.equal(calls, 1);
});

test("a broken pivot never throws into the request path", async () => {
  const verify = createPivotTokenVerifier({
    baseUrl: "http://127.0.0.1:23080",
    host: "pivot.ucas.com.cn",
    warn: () => {},
    fetchImpl: (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:23080");
    }) as unknown as typeof fetch,
  });
  assert.equal(await verify("pivot-token"), null);
});
