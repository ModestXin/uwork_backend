import type { Db } from "./db.js";

/**
 * 本机开发用的合成企业登录。
 *
 * 只在两个条件同时成立时启用，两者都拿不到就不生效，生产环境无法误开：
 *   1. `UWORK_DEV_SYNTHETIC_LOGIN` 指定要登录的成员邮箱（非空）；
 *   2. `PUBLIC_URL` 是回环地址（localhost / 127.0.0.1 / [::1]）。
 *
 * 它只替换"企微换 code"这一步：扫码 attempt、state/proof 绑定、claim 签发会话、
 * 审计与成员状态检查全部走原路径，也不覆盖任何已配置企微应用的租户。
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const SYNTHETIC_AUTHORIZE_PATH = "/api/auth/wecom/dev-synthetic";
export const SYNTHETIC_CODE = "dev-synthetic";

export interface SyntheticLogin {
  readonly email: string;
}

export function syntheticLogin(publicUrl: string): SyntheticLogin | undefined {
  const email = process.env.UWORK_DEV_SYNTHETIC_LOGIN?.trim();
  if (!email) return undefined;
  let hostname: string;
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    return undefined;
  }
  return LOOPBACK_HOSTS.has(hostname) ? { email } : undefined;
}

export function syntheticAuthorizeUrl(publicUrl: string, state: string): string {
  const url = new URL(SYNTHETIC_AUTHORIZE_PATH, publicUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${publicUrl}/api/auth/wecom/callback`);
  return url.toString();
}

/**
 * 按邮箱解析成员：只接受本租户内已存在的启用成员；首次使用时把企微账号位绑定成
 * 合成标识，让界面与既有"企微 UserId"展示口径保持一致（不改角色、席位、部门）。
 */
export function resolveSyntheticMember(
  db: Db,
  tenantId: string,
  email: string,
): string | undefined {
  const row = db.get<{ user_id: string; external_id: string | null }>(
    `SELECT m.user_id AS user_id, m.external_id AS external_id
       FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id=? AND m.status='active' AND lower(u.email)=lower(?)`,
    tenantId,
    email,
  );
  if (!row) return undefined;
  if (!row.external_id)
    db.run(
      "UPDATE members SET external_id=? WHERE tenant_id=? AND user_id=?",
      `dev-synthetic:${email.toLowerCase()}`,
      tenantId,
      row.user_id,
    );
  return row.user_id;
}
