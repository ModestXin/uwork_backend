import { createHash } from "node:crypto";

/**
 * UWork 桌面登录在 pivot（ucas-proxy control-plane），而远控的设备/配对接口在本后台：
 * 桌面拿的是 pivot 会话令牌，本后台不持有该会话。这里按既有跨服务口径**内省** pivot 的
 * `/api/auth/refresh`（与客户端"校验手机令牌"同一手法），取 `wecom_userid` 与组织，
 * 再按 `members.external_id`（企微 UserId）映射到本后台成员。
 *
 * 只在服务端内网调用；结果按令牌哈希缓存 60s，避免每个心跳都打一次 pivot。
 */

export interface RemoteExternalIdentity {
  wecomUserId: string;
  orgId: string;
}

export interface PivotTokenVerifierOptions {
  /** pivot 控制面基址，例如 http://127.0.0.1:23080（本机内网，不经公网证书）。 */
  baseUrl: string;
  /** 走该入口要带的 Host（pivot 按 Host 路由组织）。 */
  host: string;
  fetchImpl?: typeof fetch;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

export function createPivotTokenVerifier(
  options: PivotTokenVerifierOptions,
): (token: string) => Promise<RemoteExternalIdentity | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? ((message, fields) => console.warn(message, fields));
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, { identity: RemoteExternalIdentity | null; expiresAt: number }>();

  return async (token: string) => {
    const key = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.identity;
    let identity: RemoteExternalIdentity | null = null;
    try {
      const response = await fetchImpl(new URL("/api/auth/refresh", `${options.baseUrl}/`), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, host: options.host },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          user?: { wecom_userid?: unknown; org_id?: unknown };
        };
        const wecomUserId =
          typeof body.user?.wecom_userid === "string" ? body.user.wecom_userid.trim() : "";
        const orgId = typeof body.user?.org_id === "string" ? body.user.org_id.trim() : "";
        if (wecomUserId) identity = { wecomUserId, orgId };
      }
    } catch (error) {
      warn("pivot token introspection failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // 失败也缓存一个短窗口，避免坏令牌把内省打成风暴。
    cache.set(key, { identity, expiresAt: Date.now() + (identity ? ttlMs : 10_000) });
    return identity;
  };
}
