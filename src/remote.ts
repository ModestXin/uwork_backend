import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import { authenticate, requirePermission } from "./access.js";
import { fail, id, now, text, type Actor } from "./core.js";
import { ipAllowed } from "./policy.js";
import type { RemoteExternalIdentity } from "./pivot-auth.js";

/**
 * 手机远控的免扫码通路（企微内置浏览器从工作台进入）。
 *
 * 边界：
 * - 这里只有"设备存在"与"配对请求"两件事，**不存任何配对密钥**；
 * - 配对材料由桌面在应答时给出，只留在进程内 Map（TTL + 一次性），不落库；
 * - 身份仍是会话本人：跨成员的读写一律 404，不泄露存在性；
 * - relay/协议零改动：手机拿到 `{sid, hash}` 后走既有 HMAC 连接与企业身份帧。
 */

interface RemoteDeviceRow {
  device_sid: string;
  device_mid: string;
  name: string | null;
  platform: string | null;
  updated_at: number;
  expires_at: number;
}

interface PairingRow {
  id: string;
  tenant_id: string;
  user_id: string;
  device_sid: string;
  status: string;
  created_at: number;
  expires_at: number;
}

interface PairingAnswer {
  sid: string;
  hash: string;
  expiresAt: number;
}

const DEVICE_DEFAULT_TTL_SECONDS = 120;
const DEVICE_MAX_TTL_SECONDS = 600;
const PAIRING_TTL_MS = 60_000;
const PAIRING_WAIT_MAX_SECONDS = 30;
const HASH_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * 会话已由各端点内的 authenticate + requirePermission 判定；这里只补本功能额外的两条：
 * 有效席位与 IP 白名单（沿用 client 入口的既有口径，不新增准入模型）。
 */
function assertRemoteAccess(db: Db, a: Actor, ip: string) {
  if (!a.seat) fail(403, "NO_SEAT", "未分配席位");
  if (!ipAllowed(db, a, ip)) fail(403, "IP_DENIED", "企业 IP 白名单拒绝访问");
}

/** 允许携带外部（pivot）令牌访问的路径；其余 /api/client/* 仍只认本后台会话。 */
const EXTERNAL_TOKEN_PATHS = ["/api/client/remote-devices", "/api/client/remote-pairings"] as const;

export function isRemoteExternalPath(path: string): boolean {
  return EXTERNAL_TOKEN_PATHS.some(
    (allowed) => path === allowed || path.startsWith(`${allowed}/`),
  );
}

export interface RemoteRoutesOptions {
  publicUrl: string;
  /** host → tenantId（与企微入口同一套组织解析）。 */
  tenantHosts?: Record<string, string>;
  /**
   * 桌面令牌内省：UWork 登录在 pivot，桌面不带本后台会话。
   * 返回 null 表示无效；未配置时不接受任何外部令牌。
   */
  verifyExternalToken?: (token: string) => Promise<RemoteExternalIdentity | null>;
}

export function remoteRoutes(app: FastifyInstance, db: Db, options: RemoteRoutesOptions) {
  const publicUrl = options.publicUrl;
  const tenantHosts = options.tenantHosts ?? {};
  const verifyExternalToken = options.verifyExternalToken;

  /** 外部身份 → 本后台成员（按企微 UserId）；解析不出就拒绝。 */
  const pivotActor = async (
    req: { headers: Record<string, unknown> },
  ): Promise<Actor> => {
    const header = req.headers["authorization"];
    const token =
      typeof header === "string" && header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : "";
    const external = token && verifyExternalToken ? await verifyExternalToken(token) : null;
    if (!external) fail(401, "UNAUTHORIZED", "会话失效");
    const tenantId = externalTenantId(db, req.headers["host"] as string | undefined, tenantHosts);
    const member = tenantId
      ? db.get<{ user_id: string; seat: number }>(
          "SELECT user_id,seat FROM members WHERE tenant_id=? AND external_id=? AND status='active'",
          tenantId,
          external.wecomUserId,
        )
      : undefined;
    if (!member) fail(403, "MEMBER_UNMAPPED", "成员尚未同步或未分配席位");
    if (!member.seat) fail(403, "NO_SEAT", "未分配席位");
    return {
      userId: member.user_id,
      tenantId: tenantId!,
      role: "member",
      departmentId: null,
      seat: true,
      sessionHash: "",
      kind: "device",
      scopes: [],
    };
  };
  // 应答材料只在内存里存在一个配对周期，不写库。
  const answers = new Map<string, PairingAnswer>();

  /** 外部身份映射到哪个租户：先按请求 Host，其次唯一租户。 */
  function externalTenantId(
    db: Db,
    host: string | undefined,
    hosts: Record<string, string>,
  ): string | undefined {
    const normalized = host?.trim().toLowerCase();
    if (normalized) {
      const mapped = hosts[normalized] ?? hosts[normalized.split(":")[0]!];
      if (mapped && db.get("SELECT id FROM tenants WHERE id=?", mapped)) return mapped;
    }
    const tenants = db.all<{ id: string }>("SELECT id FROM tenants ORDER BY created_at");
    return tenants.length === 1 ? tenants[0]!.id : undefined;
  }

  const sweep = () => {
    const at = now();
    db.run(
      "UPDATE remote_pairings SET status='expired' WHERE status='pending' AND expires_at<=?",
      at,
    );
    for (const [key, value] of answers)
      if (value.expiresAt <= at) answers.delete(key);
    db.run("DELETE FROM remote_devices WHERE expires_at<=?", at);
  };

  const ownedDevice = (a: Actor, sid: string) => {
    const device = db.get<RemoteDeviceRow>(
      "SELECT * FROM remote_devices WHERE tenant_id=? AND user_id=? AND device_sid=? AND expires_at>?",
      a.tenantId,
      a.userId,
      sid,
      now(),
    );
    if (!device) fail(404, "NOT_FOUND", "设备不存在或已离线");
    return device;
  };

  const ownedPairing = (a: Actor, pairingId: string) => {
    const pairing = db.get<PairingRow>(
      "SELECT * FROM remote_pairings WHERE id=? AND tenant_id=? AND user_id=?",
      pairingId,
      a.tenantId,
      a.userId,
    );
    if (!pairing) fail(404, "NOT_FOUND", "配对请求不存在");
    return pairing;
  };

  app.put("/api/client/remote-devices/:sid", async (req) => {
    let a: Actor;
    try {
      a = authenticate(db, req);
      requirePermission(a, "execute");
    } catch (error) {
      // 桌面登录在 pivot：令牌不属于本后台时回落内省（手机侧仍走本后台会话）。
      if (!verifyExternalToken) throw error;
      a = await pivotActor(req);
    }
    assertRemoteAccess(db, a, req.ip);
    const { sid } = req.params as { sid: string };
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sid)) fail(400, "BAD_REQUEST", "设备标识不合法");
    const d = z
      .object({
        deviceMid: z.string().trim().min(1).max(128),
        name: z.string().trim().min(1).max(200).optional(),
        platform: z.string().trim().min(1).max(64).optional(),
        ttlSeconds: z
          .number()
          .int()
          .min(30)
          .max(DEVICE_MAX_TTL_SECONDS)
          .default(DEVICE_DEFAULT_TTL_SECONDS),
      })
      .strict()
      .parse(req.body);
    sweep();
    const at = now();
    const expiresAt = at + d.ttlSeconds * 1000;
    db.run(
      `INSERT INTO remote_devices(tenant_id,user_id,device_sid,device_mid,name,platform,expires_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id,device_sid) DO UPDATE SET
         user_id=excluded.user_id,
         device_mid=excluded.device_mid,
         name=excluded.name,
         platform=excluded.platform,
         expires_at=excluded.expires_at,
         updated_at=excluded.updated_at`,
      a.tenantId,
      a.userId,
      sid,
      d.deviceMid,
      d.name ?? null,
      d.platform ?? null,
      expiresAt,
      at,
    );
    return { ok: true, expiresAt };
  });

  app.delete("/api/client/remote-devices/:sid", async (req) => {
    let a: Actor;
    try {
      a = authenticate(db, req);
      requirePermission(a, "execute");
    } catch (error) {
      // 桌面登录在 pivot：令牌不属于本后台时回落内省（手机侧仍走本后台会话）。
      if (!verifyExternalToken) throw error;
      a = await pivotActor(req);
    }
    assertRemoteAccess(db, a, req.ip);
    const { sid } = req.params as { sid: string };
    db.run(
      "DELETE FROM remote_devices WHERE tenant_id=? AND user_id=? AND device_sid=?",
      a.tenantId,
      a.userId,
      sid,
    );
    // 设备下线后未完成的配对请求没有意义，一并作废（避免手机停在等待页）。
    db.run(
      "UPDATE remote_pairings SET status='expired' WHERE tenant_id=? AND user_id=? AND device_sid=? AND status='pending'",
      a.tenantId,
      a.userId,
      sid,
    );
    return { ok: true };
  });

  app.get("/api/client/remote-devices", async (req) => {
    let a: Actor;
    try {
      a = authenticate(db, req);
      requirePermission(a, "execute");
    } catch (error) {
      // 桌面登录在 pivot：令牌不属于本后台时回落内省（手机侧仍走本后台会话）。
      if (!verifyExternalToken) throw error;
      a = await pivotActor(req);
    }
    assertRemoteAccess(db, a, req.ip);
    sweep();
    return {
      devices: db
        .all<RemoteDeviceRow>(
          "SELECT * FROM remote_devices WHERE tenant_id=? AND user_id=? AND expires_at>? ORDER BY updated_at DESC",
          a.tenantId,
          a.userId,
          now(),
        )
        .map((row) => ({
          deviceSid: row.device_sid,
          deviceMid: row.device_mid,
          ...(row.name ? { name: row.name } : {}),
          ...(row.platform ? { platform: row.platform } : {}),
          updatedAt: row.updated_at,
          expiresAt: row.expires_at,
        })),
    };
  });

  app.post("/api/client/remote-devices/:sid/pairings", async (req, reply) => {
    let a: Actor;
    try {
      a = authenticate(db, req);
      requirePermission(a, "execute");
    } catch (error) {
      // 桌面登录在 pivot：令牌不属于本后台时回落内省（手机侧仍走本后台会话）。
      if (!verifyExternalToken) throw error;
      a = await pivotActor(req);
    }
    assertRemoteAccess(db, a, req.ip);
    const { sid } = req.params as { sid: string };
    ownedDevice(a, sid);
    sweep();
    // 同一设备只保留最近一条待应答请求，避免桌面侧队列堆积。
    db.run(
      "UPDATE remote_pairings SET status='expired' WHERE tenant_id=? AND user_id=? AND device_sid=? AND status='pending'",
      a.tenantId,
      a.userId,
      sid,
    );
    const pairingId = id();
    const at = now();
    const expiresAt = at + PAIRING_TTL_MS;
    db.run(
      "INSERT INTO remote_pairings(id,tenant_id,user_id,device_sid,status,created_at,expires_at,answered_at) VALUES(?,?,?,?,?,?,?,NULL)",
      pairingId,
      a.tenantId,
      a.userId,
      sid,
      "pending",
      at,
      expiresAt,
    );
    reply.code(201);
    return { id: pairingId, expiresAt };
  });

  app.get("/api/client/remote-devices/:sid/pairings/:id", async (req) => {
    let a: Actor;
    try {
      a = authenticate(db, req);
      requirePermission(a, "execute");
    } catch (error) {
      // 桌面登录在 pivot：令牌不属于本后台时回落内省（手机侧仍走本后台会话）。
      if (!verifyExternalToken) throw error;
      a = await pivotActor(req);
    }
    assertRemoteAccess(db, a, req.ip);
    const { sid, id: pairingId } = req.params as { sid: string; id: string };
    const pairing = ownedPairing(a, pairingId);
    if (pairing.device_sid !== sid) fail(404, "NOT_FOUND", "配对请求不存在");
    if (pairing.status === "pending" && pairing.expires_at <= now()) {
      db.run("UPDATE remote_pairings SET status='expired' WHERE id=?", pairingId);
      return { status: "expired" as const };
    }
    if (pairing.status === "answered") {
      const answer = answers.get(pairingId);
      if (!answer || answer.expiresAt <= now()) {
        answers.delete(pairingId);
        db.run("UPDATE remote_pairings SET status='expired' WHERE id=?", pairingId);
        return { status: "expired" as const };
      }
      // 材料只交付一次：读走即消费。
      answers.delete(pairingId);
      db.run("UPDATE remote_pairings SET status='consumed' WHERE id=?", pairingId);
      return {
        status: "answered" as const,
        pairing: {
          sid: answer.sid,
          hash: answer.hash,
          org: a.tenantId,
          enterpriseAuth: publicUrl,
        },
      };
    }
    if (pairing.status === "pending") return { status: "pending" as const };
    return { status: "expired" as const };
  });

  app.get("/api/client/remote-pairings/next", async (req) => {
    let a: Actor;
    try {
      a = authenticate(db, req);
      requirePermission(a, "execute");
    } catch (error) {
      // 桌面登录在 pivot：令牌不属于本后台时回落内省（手机侧仍走本后台会话）。
      if (!verifyExternalToken) throw error;
      a = await pivotActor(req);
    }
    assertRemoteAccess(db, a, req.ip);
    const query = z
      .object({
        deviceSid: z.string().min(8).max(128),
        wait: z.coerce.number().int().min(0).max(PAIRING_WAIT_MAX_SECONDS).default(25),
      })
      .strict()
      .parse(req.query);
    const deadline = now() + query.wait * 1000;
    for (;;) {
      const pending = db.get<PairingRow>(
        "SELECT * FROM remote_pairings WHERE tenant_id=? AND user_id=? AND device_sid=? AND status='pending' AND expires_at>? ORDER BY created_at LIMIT 1",
        a.tenantId,
        a.userId,
        query.deviceSid,
        now(),
      );
      if (pending)
        return {
          pairing: {
            id: pending.id,
            deviceSid: pending.device_sid,
            createdAt: pending.created_at,
            expiresAt: pending.expires_at,
          },
        };
      if (now() >= deadline) return { pairing: null };
      await delay(250);
    }
  });

  app.post("/api/client/remote-pairings/:id/answer", async (req) => {
    let a: Actor;
    try {
      a = authenticate(db, req);
      requirePermission(a, "execute");
    } catch (error) {
      // 桌面登录在 pivot：令牌不属于本后台时回落内省（手机侧仍走本后台会话）。
      if (!verifyExternalToken) throw error;
      a = await pivotActor(req);
    }
    assertRemoteAccess(db, a, req.ip);
    const { id: pairingId } = req.params as { id: string };
    // 组织绑定由本处理器完成：配对请求必须属于当前会话的 tenant + member。
    const pairing = db.get<PairingRow>(
      "SELECT * FROM remote_pairings WHERE id=? AND tenant_id=? AND user_id=?",
      pairingId,
      a.tenantId,
      a.userId,
    );
    if (!pairing) fail(404, "NOT_FOUND", "配对请求不存在");
    const d = z
      .object({ sid: text, hash: z.string().regex(HASH_PATTERN) })
      .strict()
      .parse(req.body);
    if (pairing.device_sid !== d.sid) fail(400, "BAD_REQUEST", "配对请求与设备不一致");
    if (pairing.status !== "pending" || pairing.expires_at <= now()) {
      db.run(
        "UPDATE remote_pairings SET status='expired' WHERE id=? AND status='pending'",
        pairingId,
      );
      fail(409, "PAIRING_EXPIRED", "配对请求已过期");
    }
    db.run(
      "UPDATE remote_pairings SET status='answered',answered_at=? WHERE id=? AND status='pending'",
      now(),
      pairingId,
    );
    answers.set(pairingId, {
      sid: d.sid,
      hash: d.hash,
      expiresAt: pairing.expires_at,
    });
    return { ok: true };
  });
}
