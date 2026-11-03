import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { Vault } from "./vault.js";
import { authenticate, requirePermission } from "./access.js";
import {
  issueSession,
  rateLimit,
  sessionDeliverySchema,
  sessionCookie,
  requireCookieDeliveryOrigin,
} from "./identity.js";
import { audit } from "./events.js";
import { fail, hash, id, now, secret, text } from "./core.js";
import { readJson, safeRequest } from "./network.js";
import {
  SYNTHETIC_AUTHORIZE_PATH,
  SYNTHETIC_CODE,
  resolveSyntheticMember,
  syntheticAuthorizeUrl,
  syntheticLogin,
} from "./dev-login.js";

interface EnterpriseAuth {
  tenant_id: string;
  corp_id: string;
  agent_id: string;
  credential_id: string;
}
export interface WecomProvider {
  identity(
    config: EnterpriseAuth,
    credential: string,
    code: string,
  ): Promise<string>;
  directory(
    config: EnterpriseAuth,
    credential: string,
  ): Promise<{
    departments: { id: string; name: string; parentId: string | null }[];
    members: {
      id: string;
      name: string;
      departmentId: string | null;
      active: boolean;
    }[];
  }>;
}
type WecomTransport = (
  path: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>>;
async function providerGet(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://qyapi.weixin.qq.com/cgi-bin/${path}`);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  return z
    .record(z.string(), z.unknown())
    .parse(
      await readJson(
        await safeRequest(url.toString(), { method: "GET", timeout: 15000 }),
      ),
    );
}
const departmentSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  parentid: z.number().int(),
});
const memberSchema = z.object({
  userid: z.string(),
  name: z.string(),
  department: z.array(z.number().int()),
  status: z.number().int(),
});
export function createWecomProvider(
  transport: WecomTransport = providerGet,
): WecomProvider {
  const get = async (path: string, params: Record<string, string>) => {
    const value = await transport(path, params);
    const response = z
      .object({ errcode: z.number().optional(), errmsg: z.string().optional() })
      .passthrough()
      .parse(value);
    if (response.errcode && response.errcode !== 0) {
      const detail = response.errmsg?.trim().slice(0, 160);
      // 真实 60020 是来源 IP 限制，仅提示可见范围会误导排障；不改变原拒绝状态或校验。
      const guidance =
        response.errcode === 60020
          ? "请核对应用可信 IP 与当前服务出口 IP"
          : "请核对应用可见范围与接口权限";
      // 上游错误码是排障的唯一线索：可见范围不足（60011）与凭据、可信 IP 问题的处置完全不同。
      fail(
        502,
        "WECOM_REJECTED",
        `企业微信拒绝请求（errcode ${response.errcode}）${detail ? `：${detail}` : ""}，${guidance}`,
      );
    }
    return response;
  };
  const accessToken = async (config: EnterpriseAuth, credential: string) => {
    const response = await get("gettoken", {
      corpid: config.corp_id,
      corpsecret: credential,
    });
    return z.string().min(1).parse(response.access_token);
  };
  return {
    async identity(config, credential, code) {
      const token = await accessToken(config, credential);
      const response = await get("auth/getuserinfo", {
        access_token: token,
        code,
      });
      return z
        .string()
        .min(1)
        .parse(response.userid ?? response.UserId);
    },
    async directory(config, credential) {
      const token = await accessToken(config, credential);
      const departments = await get("department/list", {
        access_token: token,
      });
      const depts = z.array(departmentSchema).parse(departments.department);
      // 自建应用只能读取「可见范围」内的通讯录，按根部门查询会因超出范围被判无权限（errcode 60011），
      // 因此逐个可见部门取成员，再按 userid 去重。
      if (!depts.length)
        fail(
          502,
          "WECOM_SCOPE_EMPTY",
          "应用可见范围内没有部门，请先在企微后台调整可见范围",
        );
      const members = new Map<string, z.infer<typeof memberSchema>>();
      for (const d of depts) {
        const users = await get("user/list", {
          access_token: token,
          department_id: String(d.id),
        });
        for (const u of z.array(memberSchema).parse(users.userlist))
          if (!members.has(u.userid)) members.set(u.userid, u);
      }
      return {
        departments: depts.map((d) => ({
          id: String(d.id),
          name: d.name,
          parentId: d.parentid ? String(d.parentid) : null,
        })),
        members: [...members.values()].map((u) => ({
          id: u.userid,
          name: u.name,
          departmentId: u.department[0] ? String(u.department[0]) : null,
          active: u.status === 1,
        })),
      };
    },
  };
}
export const wecomProvider: WecomProvider = createWecomProvider();
/** 企微内置浏览器的回跳地址：HTTPS 任意域，或本机回环 HTTP；拒绝凭据与片段。 */
function webReturnTo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(400, "INVALID_RETURN_TO", "回跳地址不合法");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    fail(400, "INVALID_RETURN_TO", "回跳地址必须为 HTTPS（本机可回环）");
  return url.toString();
}

/**
 * 同源入口的组织解析（照 ucas-proxy 的口径）：显式映射优先，其次"唯一可登录租户"，
 * 再其次"唯一租户"。解析不出来就返回 undefined，由调用方给出可读错误。
 */
function resolveTenantForRequest(
  db: Db,
  host: string | undefined,
  tenantHosts: Record<string, string>,
): string | undefined {
  const normalized = host?.trim().toLowerCase();
  if (normalized) {
    const mapped = tenantHosts[normalized] ?? tenantHosts[normalized.split(":")[0]!];
    if (mapped && db.get("SELECT id FROM tenants WHERE id=?", mapped)) return mapped;
  }
  const configured = db.all<{ tenant_id: string }>(
    "SELECT tenant_id FROM enterprise_auth ORDER BY tenant_id",
  );
  if (configured.length === 1) return configured[0]!.tenant_id;
  if (configured.length > 1) return undefined;
  const tenants = db.all<{ id: string }>("SELECT id FROM tenants ORDER BY created_at");
  return tenants.length === 1 ? tenants[0]!.id : undefined;
}

export function wecomRoutes(
  app: FastifyInstance,
  db: Db,
  vault: Vault,
  publicUrl: string,
  provider: WecomProvider = wecomProvider,
  tenantHosts: Record<string, string> = {},
) {
  const configuration = (tenantId: string) => {
    const c = db.get<EnterpriseAuth>(
      "SELECT * FROM enterprise_auth WHERE tenant_id=?",
      tenantId,
    );
    if (!c) fail(503, "WECOM_NOT_CONFIGURED", "组织尚未配置企业微信应用");
    return c;
  };
  app.get("/api/tenants/:tenantId/wecom", async (req) => {
    const a = authenticate(db, req);
    requirePermission(a, "identity");
    return {
      configuration:
        db.get<EnterpriseAuth>(
          "SELECT * FROM enterprise_auth WHERE tenant_id=?",
          a.tenantId,
        ) ?? null,
      callbackUrl: `${publicUrl}/api/auth/wecom/callback`,
    };
  });
  app.put("/api/tenants/:tenantId/wecom", async (req) => {
    const a = authenticate(db, req);
    requirePermission(a, "vault");
    const d = z
      .object({
        corpId: text,
        agentId: z.string().regex(/^\d+$/),
        credentialId: text,
      })
      .strict()
      .parse(req.body);
    vault.read(a.tenantId, d.credentialId);
    const old = db.get<EnterpriseAuth>(
      "SELECT * FROM enterprise_auth WHERE tenant_id=?",
      a.tenantId,
    );
    if (old && old.corp_id !== d.corpId)
      fail(409, "CORP_IMMUTABLE", "已绑定企业不能直接更换 CorpId");
    db.run(
      "INSERT INTO enterprise_auth VALUES(?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET agent_id=excluded.agent_id,credential_id=excluded.credential_id",
      a.tenantId,
      d.corpId,
      d.agentId,
      d.credentialId,
    );
    audit(db, a, "wecom.configure");
    return { ok: true };
  });
  app.post("/api/auth/wecom/attempts", async (req, reply) => {
    rateLimit(db, `wecom:${req.ip}`, 30);
    const { tenantId: requestedTenantId, mode, returnTo } = z
      .object({
        /** 省略时按请求 Host 解析（页面与后台同源的新入口不需要传组织）。 */
        tenantId: text.optional(),
        /** web = 企微内置浏览器内的网页授权（snsapi_base）；qr = 既有扫码登录页。 */
        mode: z.enum(["qr", "web"]).default("qr"),
        /** web 模式下授权完成后回到哪个页面（手机页自己）；缺省回到本后台回调页。 */
        returnTo: z.string().max(2048).optional(),
      })
      .strict()
      .parse(req.body);
    const webReturnPath = mode === "web" ? webReturnTo(returnTo) : undefined;
    const tenantId =
      requestedTenantId ??
      resolveTenantForRequest(db, req.headers.host, tenantHosts) ??
      fail(400, "TENANT_REQUIRED", "无法确定组织，请指定 tenantId");
    const configured = db.get<EnterpriseAuth>(
      "SELECT * FROM enterprise_auth WHERE tenant_id=?",
      tenantId,
    );
    // 已配置企微的租户永远走真实扫码；只有未配置 + 回环开发态才回落合成登录。
    const devSynthetic = configured ? undefined : syntheticLogin(publicUrl);
    if (!configured && !devSynthetic)
      fail(503, "WECOM_NOT_CONFIGURED", "组织尚未配置企业微信应用");
    const attemptId = id(),
      proof = secret(),
      state = attemptId;
    db.run(
      "INSERT INTO login_attempts VALUES(?,?,?,?,?,NULL,?)",
      attemptId,
      tenantId,
      hash(state),
      hash(proof),
      "pending",
      now() + 5 * 60000,
    );
    let authorizeUrl: string;
    if (configured && mode === "web") {
      // 企微内置浏览器用 OAuth2 网页授权：免扫码、静默拿 code，然后回跳到手机页自己换会话。
      const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
      for (const [k, v] of Object.entries({
        appid: configured.corp_id,
        redirect_uri: webReturnPath ?? `${publicUrl}/api/auth/wecom/callback`,
        response_type: "code",
        scope: "snsapi_base",
        state,
      }))
        url.searchParams.set(k, v);
      url.hash = "wechat_redirect";
      authorizeUrl = url.toString();
    } else if (configured) {
      const url = new URL("https://login.work.weixin.qq.com/wwlogin/sso/login");
      for (const [k, v] of Object.entries({
        appid: configured.corp_id,
        agentid: configured.agent_id,
        redirect_uri: `${publicUrl}/api/auth/wecom/callback`,
        state,
        login_type: "CorpApp",
        lang: "zh",
      }))
        url.searchParams.set(k, v);
      authorizeUrl = url.toString();
    } else {
      // 合成授权页就在本机后台，真正换 code 的那一步被替换，其余流程不变。
      authorizeUrl = syntheticAuthorizeUrl(publicUrl, state, webReturnPath);
    }
    reply.code(201);
    return {
      id: attemptId,
      proof,
      expiresAt: now() + 5 * 60000,
      authorizeUrl,
    };
  });
  /**
   * 同源入口探测：手机页与后台同源时不再需要把 ``backend``/``org``/``enterprise_auth``
   * 写进企微应用主页（照 ucas-proxy"页面与 API 同源、组织由 Host 解析"的口径）。
   * 非本后端的 origin 直接 404，页面据此回落到二维码/参数入口。
   */
  app.get("/api/auth/wecom/web-config", async (req) => {
    const tenantId = resolveTenantForRequest(db, req.headers.host, tenantHosts);
    if (!tenantId) fail(404, "NOT_FOUND", "请求无法处理");
    const configured = db.get<EnterpriseAuth>(
      "SELECT * FROM enterprise_auth WHERE tenant_id=?",
      tenantId,
    );
    if (!configured && !syntheticLogin(publicUrl)) fail(404, "NOT_FOUND", "请求无法处理");
    return { backend: "uwork" as const, tenantId };
  });
  app.get("/api/auth/wecom/dev-synthetic", async (req, reply) => {
    if (!syntheticLogin(publicUrl)) fail(404, "NOT_FOUND", "请求无法处理");
    const query = z
      .object({
        state: z.string().min(1).max(200),
        redirect_uri: z.string().max(2048),
        return_to: z.string().max(2048).optional(),
      })
      .strict()
      .parse(req.query);
    if (query.redirect_uri !== `${publicUrl}/api/auth/wecom/callback`)
      fail(400, "INVALID_REDIRECT", "授权回调地址不匹配");
    const returnPath = webReturnTo(query.return_to);
    const attempt = db.get<{ id: string }>(
      "SELECT id FROM login_attempts WHERE state_hash=? AND status='pending' AND expires_at>?",
      hash(query.state),
      now(),
    );
    if (!attempt) fail(400, "INVALID_STATE", "扫码尝试已过期或已使用");
    const target = new URL(query.redirect_uri);
    target.searchParams.set("state", query.state);
    target.searchParams.set("code", SYNTHETIC_CODE);
    if (returnPath) target.searchParams.set("return_to", returnPath);
    return reply.redirect(target.toString());
  });
  const verifyAttempt = async (query: { state: string; code: string }) => {
    const attempt = db.get<{ id: string; tenant_id: string }>(
      "SELECT id,tenant_id FROM login_attempts WHERE state_hash=? AND status='pending' AND expires_at>?",
      hash(query.state),
      now(),
    );
    if (!attempt) fail(400, "INVALID_STATE", "扫码尝试已过期或已使用");
    db.run(
      "UPDATE login_attempts SET status='verifying' WHERE id=? AND status='pending'",
      attempt.id,
    );
    try {
      const devSynthetic =
        query.code === SYNTHETIC_CODE ? syntheticLogin(publicUrl) : undefined;
      let member: { user_id: string } | undefined;
      let tenantId = attempt.tenant_id;
      if (devSynthetic) {
        const userId = resolveSyntheticMember(db, attempt.tenant_id, devSynthetic.email);
        if (userId) member = { user_id: userId };
      } else {
        const c = configuration(attempt.tenant_id);
        tenantId = c.tenant_id;
        const externalId = await provider.identity(
          c,
          vault.read(c.tenant_id, c.credential_id),
          query.code,
        );
        member = db.get<{ user_id: string }>(
          "SELECT user_id FROM members WHERE tenant_id=? AND external_id=? AND status='active'",
          c.tenant_id,
          externalId,
        );
      }
      if (!member)
        fail(403, "MEMBER_UNMAPPED", "成员尚未同步或绑定，请联系管理员");
      if (
        !db.run(
          "UPDATE login_attempts SET status='authorized',user_id=? WHERE id=? AND status='verifying' AND expires_at>?",
          member.user_id,
          attempt.id,
          now(),
        ).changes
      )
        fail(409, "ATTEMPT_USED", "扫码尝试已取消或过期");
      audit(
        db,
        { tenantId, userId: member.user_id },
        "wecom.authorized",
      );
    } catch (error) {
      db.run(
        "UPDATE login_attempts SET status='failed' WHERE id=? AND status='verifying'",
        attempt.id,
      );
      throw error;
    }
  };
  app.get("/api/auth/wecom/callback", async (req, reply) => {
    const query = z
      .object({
        state: z.string().min(1).max(200),
        code: z.string().min(1).max(1024),
        /** 仅开发态合成登录使用：把 state/code 交回手机页。 */
        return_to: z.string().max(2048).optional(),
      })
      .parse(req.query);
    const returnPath = webReturnTo(query.return_to);
    await verifyAttempt({ state: query.state, code: query.code });
    if (returnPath) {
      // 开发态合成登录：把 state/code 交回手机页，由页面完成 claim（真实 web 流程不经过这里）。
      const target = new URL(returnPath);
      target.searchParams.set("state", query.state);
      target.searchParams.set("code", query.code);
      return reply.redirect(target.toString());
    }
    return reply
      .type("text/plain; charset=utf-8")
      .send("扫码验证完成，请返回 UWork。");
  });
  app.post("/api/auth/wecom/attempts/:id/complete", async (req) => {
    rateLimit(db, `wecom-complete:${req.ip}`, 30);
    const attemptId = (req.params as { id: string }).id;
    const d = z
      .object({ proof: z.string().max(200), code: z.string().min(1).max(1024) })
      .strict()
      .parse(req.body);
    const attempt = db.get<{ status: string }>(
      "SELECT status FROM login_attempts WHERE id=? AND proof_hash=? AND expires_at>?",
      attemptId,
      hash(d.proof),
      now(),
    );
    if (!attempt) fail(400, "ATTEMPT_EXPIRED", "扫码尝试不存在或已过期");
    if (attempt.status === "authorized") return { ok: true };
    await verifyAttempt({ state: attemptId, code: d.code });
    return { ok: true };
  });
  app.post("/api/auth/wecom/attempts/:id/claim", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { proof, delivery } = z
      .object({
        proof: z.string().min(1).max(200),
        delivery: sessionDeliverySchema,
      })
      .strict()
      .parse(req.body);
    requireCookieDeliveryOrigin(req, publicUrl, delivery);
    rateLimit(db, `claim:${req.ip}`, 300, 60000);
    return db.transaction(() => {
      const attempt = db.get<{
        tenant_id: string;
        user_id: string | null;
        status: string;
        expires_at: number;
      }>(
        "SELECT * FROM login_attempts WHERE id=? AND proof_hash=?",
        id,
        hash(proof),
      );
      if (!attempt || attempt.expires_at <= now())
        fail(400, "ATTEMPT_EXPIRED", "扫码尝试不存在或已过期");
      if (attempt.status === "claimed" || attempt.status === "cancelled")
        fail(409, "ATTEMPT_USED", "扫码尝试已使用或取消");
      if (attempt.status !== "authorized" || !attempt.user_id)
        return { status: attempt.status };
      if (
        !db.get(
          "SELECT user_id FROM members WHERE tenant_id=? AND user_id=? AND status='active'",
          attempt.tenant_id,
          attempt.user_id,
        )
      )
        fail(403, "MEMBER_INACTIVE", "成员已停用");
      db.run(
        "UPDATE login_attempts SET status='claimed' WHERE id=? AND status='authorized'",
        id,
      );
      const issued = issueSession(db, attempt.user_id, attempt.tenant_id);
      if (delivery === "cookie") {
        reply.header(
          "set-cookie",
          sessionCookie(issued.token, 43200, publicUrl),
        );
        return {
          status: "claimed",
          expiresAt: issued.expiresAt,
          tenantId: attempt.tenant_id,
        };
      }
      return {
        status: "authorized",
        ...issued,
        tenantId: attempt.tenant_id,
      };
    });
  });
  app.post("/api/auth/wecom/attempts/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const { proof } = z
      .object({ proof: z.string().max(200) })
      .strict()
      .parse(req.body);
    db.run(
      "UPDATE login_attempts SET status='cancelled' WHERE id=? AND proof_hash=? AND status IN ('pending','verifying','authorized')",
      id,
      hash(proof),
    );
    return { ok: true };
  });
  app.put("/api/tenants/:tenantId/members/:id/wecom", async (req) => {
    const a = authenticate(db, req);
    requirePermission(a, "identity");
    const { id } = req.params as { id: string };
    const { externalId } = z
      .object({ externalId: text })
      .strict()
      .parse(req.body);
    configuration(a.tenantId);
    if (
      db.get(
        "SELECT user_id FROM members WHERE tenant_id=? AND external_id=? AND user_id<>?",
        a.tenantId,
        externalId,
        id,
      )
    )
      fail(409, "IDENTITY_BOUND", "企微身份已绑定");
    if (
      !db.run(
        "UPDATE members SET external_id=? WHERE tenant_id=? AND user_id=?",
        externalId,
        a.tenantId,
        id,
      ).changes
    )
      fail(404, "NOT_FOUND", "成员不存在");
    audit(db, a, "wecom.member.bind", id);
    return { ok: true };
  });
  app.post("/api/tenants/:tenantId/wecom/sync", async (req) => {
    const a = authenticate(db, req);
    requirePermission(a, "identity");
    const c = configuration(a.tenantId);
    const data = await provider.directory(
      c,
      vault.read(a.tenantId, c.credential_id),
    );
    db.transaction(() => {
      const mapping = new Map<string, string>();
      for (const d of data.departments) {
        const existing = db.get<{ id: string }>(
          "SELECT id FROM departments WHERE tenant_id=? AND external_id=?",
          a.tenantId,
          d.id,
        );
        const departmentId = existing?.id ?? id();
        mapping.set(d.id, departmentId);
        db.run(
          "INSERT INTO departments(id,tenant_id,name,source,external_id) VALUES(?,?,?,'wecom',?) ON CONFLICT(tenant_id,external_id) DO UPDATE SET name=excluded.name",
          departmentId,
          a.tenantId,
          d.name,
          d.id,
        );
      }
      for (const d of data.departments)
        db.run(
          "UPDATE departments SET parent_id=? WHERE tenant_id=? AND id=?",
          d.parentId ? (mapping.get(d.parentId) ?? null) : null,
          a.tenantId,
          mapping.get(d.id)!,
        );
      for (const m of data.members) {
        const existing = db.get<{ user_id: string; role: string }>(
          "SELECT user_id,role FROM members WHERE tenant_id=? AND external_id=?",
          a.tenantId,
          m.id,
        );
        const userId = existing?.user_id ?? id();
        if (!existing) {
          db.run(
            "INSERT INTO users VALUES(?,NULL,?,NULL,?)",
            userId,
            m.name,
            now(),
          );
          db.run(
            "INSERT INTO members(tenant_id,user_id,role,department_id,status,seat,source,external_id) VALUES(?,?,'member',?,?,0,'wecom',?)",
            a.tenantId,
            userId,
            m.departmentId ? (mapping.get(m.departmentId) ?? null) : null,
            m.active ? "active" : "disabled",
            m.id,
          );
        } else {
          db.run("UPDATE users SET name=? WHERE id=?", m.name, userId);
          if (existing.role !== "owner") {
            db.run(
              "UPDATE members SET department_id=?,status=? WHERE tenant_id=? AND user_id=?",
              m.departmentId ? (mapping.get(m.departmentId) ?? null) : null,
              m.active ? "active" : "disabled",
              a.tenantId,
              userId,
            );
            if (!m.active)
              db.run(
                "DELETE FROM sessions WHERE tenant_id=? AND user_id=?",
                a.tenantId,
                userId,
              );
          }
        }
      }
      const ids = new Set(data.members.map((m) => m.id));
      for (const m of db.all<{ user_id: string; external_id: string }>(
        "SELECT user_id,external_id FROM members WHERE tenant_id=? AND source='wecom' AND role<>'owner'",
        a.tenantId,
      ))
        if (!ids.has(m.external_id)) {
          db.run(
            "UPDATE members SET status='disabled' WHERE tenant_id=? AND user_id=?",
            a.tenantId,
            m.user_id,
          );
          db.run(
            "DELETE FROM sessions WHERE tenant_id=? AND user_id=?",
            a.tenantId,
            m.user_id,
          );
        }
      audit(db, a, "wecom.directory.sync", undefined, {
        departments: data.departments.length,
        members: data.members.length,
      });
    });
    return {
      departments: data.departments.length,
      members: data.members.length,
    };
  });
}
