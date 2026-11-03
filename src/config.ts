import { z } from "zod";
export const privateModelOriginsSchema = z
  .array(
    z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        );
      }, "Private model entries must be credential-free HTTPS origins")
      .transform((value) => new URL(value).origin),
  )
  .max(20)
  .transform((origins) => [...new Set(origins)]);
export function environment() {
  const env = z
    .object({
      DATABASE_PATH: z.string().default("data/uwork.sqlite"),
      MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
      PUBLIC_URL: z
        .url()
        .refine((value) => {
          const u = new URL(value);
          return (
            ["https:", "http:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash &&
            u.pathname === "/"
          );
        }, "PUBLIC_URL must be a credential-free HTTP(S) origin")
        .default("http://localhost:3000"),
      HOST: z.string().default("127.0.0.1"),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      ALLOW_PRIVATE_UPSTREAMS: z.enum(["true", "false"]).default("false"),
      PRIVATE_MODEL_ORIGINS: z
        .string()
        .max(8192)
        .default("")
        .transform((value) =>
          value.trim() ? value.split(",").map((entry) => entry.trim()) : [],
        )
        .pipe(privateModelOriginsSchema),
      /**
       * 组织路由（照 ucas-proxy 的 host → org 口径）：`host=tenantId` 逗号分隔，
       * 形如 `uwork.ucas.com.cn=<id>,localhost:3210=<id>`；用于同源入口自动解析租户。
       */
      TENANT_HOSTS: z.string().max(4096).default(""),
      SANDBOX_DOCKER_SOCKET: z.string().max(512).optional(),
      SANDBOX_IMAGE: z.string().max(256).default("uwork-sandbox:local"),
    })
    .parse(process.env);
  if (
    !env.PUBLIC_URL.startsWith("https://") &&
    !["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(env.PUBLIC_URL).hostname,
    )
  )
    throw new Error("PUBLIC_URL requires HTTPS outside loopback");
  return {
    database: env.DATABASE_PATH,
    masterKey: Buffer.from(env.MASTER_KEY, "hex"),
    publicUrl: env.PUBLIC_URL,
    host: env.HOST,
    port: env.PORT,
    allowPrivateUpstreams: env.ALLOW_PRIVATE_UPSTREAMS === "true",
    privateModelOrigins: env.PRIVATE_MODEL_ORIGINS,
    tenantHosts: parseTenantHosts(env.TENANT_HOSTS),
    sandboxSocket: env.SANDBOX_DOCKER_SOCKET,
    sandboxImage: env.SANDBOX_IMAGE,
  };
}

/** `host=tenantId` 列表；主机名小写、允许带端口（本机调试）。非法项直接忽略。 */
export function parseTenantHosts(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const host = trimmed.slice(0, separator).trim().toLowerCase();
    const tenantId = trimmed.slice(separator + 1).trim();
    if (!host || !tenantId || host.includes("/")) continue;
    map[host] = tenantId;
  }
  return map;
}
