import Fastify, { LogController } from "fastify";
import { z } from "zod";
import { Db } from "./db.js";
import { ApiError, fail, id, now } from "./core.js";
import { authenticate, tenantAccess, requirePermission } from "./access.js";
import { identityRoutes, purgeIdentity } from "./identity.js";
import { directoryRoutes } from "./directory.js";
import { Vault, vaultRoutes } from "./vault.js";
import { Entitlements, entitlementRoutes } from "./entitlements.js";
import { modelsRoutes } from "./models.js";
import { Gateway, gatewayRoutes } from "./gateway.js";
import { assetRoutes } from "./assets.js";
import { policyRoutes, ipAllowed } from "./policy.js";
import { clientRoutes } from "./client.js";
import { remoteRoutes } from "./remote.js";
import { sharingRoutes, purgeExpiredShares } from "./sharing.js";
import { sharingViewerRoutes } from "./sharing-viewer.js";
import { clientConsoleRoutes } from "./client-console.js";
import { Runtime, runtimeRoutes } from "./runtime.js";
import { AutomationWorker, automationRoutes } from "./automation.js";
import { EvaluationWorker, evaluationRoutes } from "./evaluation.js";
import { wecomRoutes, type WecomProvider } from "./wecom.js";
import { retentionSweep, telemetryRoutes } from "./telemetry.js";
import { integrationRoutes } from "./integrations.js";
import { connectorRoutes } from "./connectors.js";
import { staticRoutes } from "./static.js";
import { openApi } from "./openapi.js";
import { clientUsageRoutes } from "./client-usage.js";
import { privateModelOriginsSchema } from "./config.js";
import { SandboxService } from "./sandbox/service.js";
import { sandboxRoutes } from "./sandbox/routes.js";
import { DockerSandboxDriver } from "./sandbox/docker.js";
import type { SandboxDriver } from "./sandbox/contract.js";
import { AgentToolRunner } from "./agent-runner.js";
import { ConnectorService } from "./connector-service.js";

export interface AppOptions {
  database: string;
  masterKey: Buffer;
  publicUrl: string;
  allowPrivateUpstreams?: boolean;
  privateModelOrigins?: string[];
  logger?: boolean;
  worker?: boolean;
  wecomProvider?: WecomProvider;
  sandboxDriver?: SandboxDriver;
  sandboxSocket?: string;
  sandboxImage?: string;
  /** host → tenantId（同源入口自动解析组织；缺省读环境变量）。 */
  tenantHosts?: Record<string, string>;
}
export async function createApp(options: AppOptions) {
  if (options.masterKey.length !== 32)
    throw new Error("MASTER_KEY must contain 32 bytes");
  const privateModelOrigins = privateModelOriginsSchema.parse(
    options.privateModelOrigins ?? [],
  );
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body",
            "res.headers.set-cookie",
          ],
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 60000,
    trustProxy: false,
  });
  const instanceOwner = id();
  const db = new Db(
    options.database,
    options.database !== ":memory:" ? instanceOwner : undefined,
  );
  openApi(app, options.publicUrl);
  const vault = new Vault(db, options.masterKey);
  const entitlements = new Entitlements(db);
  entitlements.recoverPending();
  const gateway = new Gateway(
    db,
    vault,
    entitlements,
    options.allowPrivateUpstreams ?? false,
    privateModelOrigins,
  );
  const sandboxDriver =
    options.sandboxDriver ??
    (options.sandboxSocket
      ? new DockerSandboxDriver(
          options.sandboxSocket,
          options.sandboxImage ?? "uwork-sandbox:local",
        )
      : undefined);
  const sandbox = new SandboxService(db, vault, sandboxDriver, (actor) => {
    requirePermission(actor, "execute");
    entitlements.subscription(actor.tenantId);
  });
  const connectors = new ConnectorService(
    db,
    vault,
    options.allowPrivateUpstreams ?? false,
  );
  const agentTools = new AgentToolRunner(
    db,
    vault,
    gateway,
    sandbox,
    connectors,
  );
  const runtime = new Runtime(db, gateway, vault, agentTools);
  const automation = new AutomationWorker(
    db,
    runtime,
    vault,
    options.allowPrivateUpstreams ?? false,
  );
  const evaluation = new EvaluationWorker(db, runtime, vault);
  let workerHealthy = true;
  let leaseLost = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let delivery: Promise<void> | undefined;
  const stopWorkers = () =>
    Promise.allSettled([runtime.stop(), sandbox.stop(), automation.stop()]);
  const heartbeat =
    options.database !== ":memory:"
      ? setInterval(() => {
          try {
            db.renewInstance(instanceOwner);
          } catch {
            leaseLost = true;
            workerHealthy = false;
            clearInterval(interval);
            clearInterval(heartbeat);
            void stopWorkers();
            app.log.error(
              { code: "INSTANCE_LEASE_LOST" },
              "Database lease lost; workers stopped",
            );
          }
        }, 15000)
      : undefined;
  heartbeat?.unref();
  app.addHook("onClose", async () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    const result = await stopWorkers();
    if (result.some((item) => item.status === "rejected"))
      app.log.error(
        { code: "WORKER_SHUTDOWN_FAILURE" },
        "One or more workers failed during shutdown",
      );
    db.close();
  });
  try {
    await sandbox.recover();
    db.assertInstance();
  } catch (error) {
    await app.close();
    throw error;
  }
  const services = {
    db,
    vault,
    entitlements,
    gateway,
    runtime,
    automation,
    evaluation,
    sandbox,
  };
  app.decorate("services", services);
  const decorated = app as typeof app & { services: typeof services };
  app.addHook("onRequest", async (req, reply) => {
    try {
      if (leaseLost) throw new Error("Lease lost");
      db.assertInstance();
    } catch {
      fail(503, "INSTANCE_LEASE_LOST", "数据库实例所有权已失效，请重启服务");
    }
    reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store");
    if (options.publicUrl.startsWith("https:"))
      reply.header("strict-transport-security", "max-age=31536000");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== new URL(options.publicUrl).origin)
        fail(403, "ORIGIN_REJECTED", "请求来源不允许");
      if (
        req.headers.cookie?.includes("uwork_session=") &&
        !req.headers.authorization?.startsWith("Bearer ") &&
        !origin
      )
        fail(403, "ORIGIN_REQUIRED", "会话写入需要来源校验");
    }
    const path = req.url.split("?")[0]!;
    const tenantId = /^\/api\/tenants\/([^/]+)/.exec(path)?.[1];
    if (tenantId) tenantAccess(authenticate(db, req), tenantId);
    if (path.startsWith("/api/client/") || path.startsWith("/v1/")) {
      const a = authenticate(db, req);
      if (!ipAllowed(db, a, req.ip))
        fail(403, "IP_DENIED", "企业 IP 白名单拒绝访问");
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message },
        requestId: req.id,
      });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION",
          message: "输入格式不正确",
          fields: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        requestId: req.id,
      });
    if (
      typeof error === "object" &&
      error &&
      "statusCode" in error &&
      Number(error.statusCode) < 500
    )
      return reply.code(Number(error.statusCode)).send({
        error: { code: "BAD_REQUEST", message: "请求无法处理" },
        requestId: req.id,
      });
    req.log.error({ requestId: req.id }, "Unhandled server error");
    return reply.code(500).send({
      error: { code: "INTERNAL", message: "服务处理失败" },
      requestId: req.id,
    });
  });
  app.get("/health", async (_req, reply) => {
    const healthy =
      workerHealthy &&
      !sandbox.failure &&
      !runtime.failure &&
      !!db.get("SELECT 1");
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? "ok" : "degraded", version: "0.1.0" });
  });
  identityRoutes(app, db, options.publicUrl);
  directoryRoutes(app, db);
  vaultRoutes(app, db, vault);
  entitlementRoutes(app, db);
  modelsRoutes(
    app,
    db,
    vault,
    options.allowPrivateUpstreams ?? false,
    privateModelOrigins,
  );
  gatewayRoutes(app, db, gateway);
  assetRoutes(app, db);
  policyRoutes(app, db);
  clientRoutes(app, db);
  remoteRoutes(app, db, options.publicUrl);
  sharingRoutes(app, db, options.publicUrl);
  sharingViewerRoutes(app, db);
  purgeExpiredShares(db);
  clientConsoleRoutes(app, db, runtime);
  clientUsageRoutes(app, db, entitlements);
  sandboxRoutes(app, db, sandbox);
  runtimeRoutes(
    app,
    db,
    runtime,
    async () => (await sandbox.health()).available,
  );
  automationRoutes(app, db, runtime, vault);
  evaluationRoutes(app, db, runtime, vault, evaluation);
  wecomRoutes(
    app,
    db,
    vault,
    options.publicUrl,
    options.wecomProvider,
    options.tenantHosts ?? {},
  );
  const retentionPorts = {
    purgeCalls: (tenant: string, before: number) =>
      gateway.purgeCalls(tenant, before),
    purgeRuns: (tenant: string, before: number) =>
      runtime.purgeFinished(tenant, before),
    purgeSandbox: (tenant: string, before: number) =>
      sandbox.purgeFinished(tenant, before),
    purgeIdentity: (time: number) => purgeIdentity(db, time),
  };
  telemetryRoutes(app, db, retentionPorts);
  integrationRoutes(
    app,
    db,
    vault,
    options.allowPrivateUpstreams ?? false,
    async () => (await sandbox.health()).available,
  );
  connectorRoutes(app, db, connectors);
  staticRoutes(app);
  // 企业留存巡检：每小时一次，只清理显式配置过留存天数的企业。
  let lastRetentionSweep = 0;
  let lastSharingSweep = now();
  const RETENTION_SWEEP_INTERVAL_MS = 3600000;
  if (options.worker)
    interval = setInterval(() => {
      try {
        db.assertInstance();
        workerHealthy = true;
        if (now() - lastRetentionSweep >= RETENTION_SWEEP_INTERVAL_MS) {
          lastRetentionSweep = now();
          try {
            retentionSweep(db, retentionPorts, now());
          } catch {
            // 留存巡检失败不能让自动化/任务分派停摆；下一小时重试。
            app.log.error(
              { code: "RETENTION_SWEEP_FAILURE" },
              "Retention sweep failed",
            );
          }
        }
        if (now() - lastSharingSweep >= 60000) {
          lastSharingSweep = now();
          try {
            purgeExpiredShares(db);
          } catch {
            // 分享过期清理有界重试，不影响任务分派；访问端仍独立检查到期。
            app.log.error(
              { code: "SHARING_CLEANUP_FAILURE" },
              "Sharing cleanup failed",
            );
          }
        }
        automation.tick();
        runtime.pump();
        sandbox.pump();
        evaluation.tick();
        if (!delivery)
          delivery = automation
            .deliver()
            .catch(() => {
              workerHealthy = false;
              app.log.error(
                { code: "DELIVERY_WORKER_FAILURE" },
                "Delivery worker failed",
              );
            })
            .finally(() => {
              delivery = undefined;
            });
      } catch {
        workerHealthy = false;
        app.log.error({ code: "SCHEDULER_FAILURE" }, "Scheduler failed");
      }
    }, 1000);
  // Fastify's thenable signature otherwise erases decorated types when awaited.
  return decorated as Omit<typeof decorated, "then">;
}
