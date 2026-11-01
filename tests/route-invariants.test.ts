import assert from "node:assert/strict";
import { test } from "node:test";
import { routes, type Route } from "./route-source.js";

/** 公开入口：登录、企微扫码/回调、健康检查、OpenAPI 与静态资源。 */
const publicPaths = [
  "/api/auth/login",
  "/api/auth/shares/:code/context",
  "/api/auth/wecom/attempts",
  "/api/auth/wecom/attempts/:id/complete",
  "/api/auth/wecom/attempts/:id/claim",
  "/api/auth/wecom/attempts/:id/cancel",
  "/api/auth/wecom/callback",
  // 本机开发态合成授权页：不鉴权（就是"扫码页"），但只在回环 + 显式 env 下存在。
  "/api/auth/wecom/dev-synthetic",
  "/api/openapi.json",
];
/** 权限判定写在被调用服务内部的端点。 */
const serviceChecked = [
  "/api/tenants/:tenantId/runs",
  "/api/tenants/:tenantId/runs/:id/cancel",
];

// 新组织只读入口由同一分享 service 鉴权，查看不应错误要求模型席位。
// 精确到 method/path/真实调用；不能以整个 shares 前缀跳过守卫。
const sharingOwners: Record<string, string[]> = {
  "GET /api/client/shares/capabilities": ["publisher"],
  "POST /api/client/shares/preparations": ["publisher"],
  "POST /api/client/shares/preparations/:id/artifacts": [
    "session",
    "ownedPreparation",
    "assertPublisher",
  ],
  "POST /api/client/shares/preparations/:id/confirm": [
    "session",
    "ownedPreparation",
    "assertPublisher",
  ],
  "GET /api/client/shares/:code/preview": ["readShareForViewer"],
  "GET /api/client/shares/:code/artifacts/:id": ["artifactForViewer"],
  "GET /api/client/shares/:code/artifacts/:id/content": ["artifactForViewer"],
  "DELETE /api/client/shares/:code": ["session", "requirePermission"],
  "POST /api/client/shares/:code/continuation": ["viewer"],
};
function sharingChecked(route: Route) {
  const owners = sharingOwners[`${route.method} ${route.path}`];
  return (
    owners !== undefined && owners.every((owner) => route.calls.includes(owner))
  );
}
function subscriptionOwnerChecked(route: Route) {
  return (
    route.method === "PUT" &&
    route.path === "/api/tenants/:tenantId/subscription" &&
    route.calls.includes("fail") &&
    route.body.includes('a.role !== "owner"') &&
    route.body.includes('a.kind !== "session"')
  );
}

test("every business route authenticates and checks a permission", () => {
  const offenders: string[] = [];
  for (const route of routes()) {
    if (!route.path.startsWith("/api/") && !route.path.startsWith("/v1/"))
      continue;
    if (publicPaths.includes(route.path)) continue;
    if (!route.calls.includes("authenticate") && !sharingChecked(route))
      offenders.push(`${route.file}:${route.line} ${route.path} 未认证`);
    if (
      route.path.startsWith("/api/tenants/") &&
      !route.body.includes("requirePermission(") &&
      !route.body.includes("tenantAccess(") &&
      !subscriptionOwnerChecked(route) &&
      !serviceChecked.includes(route.path)
    )
      offenders.push(`${route.file}:${route.line} ${route.path} 未做权限判定`);
  }
  assert.deepEqual(
    offenders,
    [],
    `路由认证/权限不变量被破坏：\n${offenders.join("\n")}`,
  );
});

test("a tenant-scoped route never authorises with a caller-supplied tenant id", () => {
  const offenders: string[] = [];
  for (const route of routes()) {
    if (!route.body.includes("params as { tenantId")) continue;
    // 参数里的 tenantId 只能交给 tenantAccess 校验；越权与否由登录态决定。
    if (!route.body.includes("tenantAccess("))
      offenders.push(
        `${route.file}:${route.line} ${route.path} 直接使用请求参数里的 tenantId`,
      );
  }
  assert.deepEqual(
    offenders,
    [],
    `跨租户信任被破坏：\n${offenders.join("\n")}`,
  );
});

test("client and gateway routes gate on their current tenant and appropriate execution or member permissions", () => {
  const offenders: string[] = [];
  for (const route of routes()) {
    const scoped =
      route.path.startsWith("/api/client/") || route.path.startsWith("/v1/");
    if (!scoped || route.path === "/api/client/events") continue;
    if (sharingChecked(route)) continue;
    if (!route.body.includes("authenticate("))
      offenders.push(`${route.file}:${route.line} ${route.path} 未认证`);
    if (
      !route.body.includes("requirePermission(") &&
      !route.body.includes("assertExecution(") &&
      !route.body.includes("gateway.complete(") &&
      !route.body.includes("connectors.rpc(") &&
      !route.body.includes("connectors.authorize(")
    )
      offenders.push(
        `${route.file}:${route.line} ${route.path} 缺少执行权限判定`,
      );
    // 组织绑定可以由处理器自己做，也可以在被调用服务内部（连接器/网关）完成。
    const bound =
      route.body.includes(".tenantId") ||
      route.body.includes("connectors.rpc(") ||
      route.body.includes("connectors.release(") ||
      route.body.includes("connectors.authorize(") ||
      route.body.includes("gateway.complete(");
    if (!bound)
      offenders.push(
        `${route.file}:${route.line} ${route.path} 未绑定当前组织的 tenant`,
      );
  }
  assert.deepEqual(
    offenders,
    [],
    `客户端入口不变量被破坏：\n${offenders.join("\n")}`,
  );
});
