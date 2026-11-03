import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { SHARING_SCHEMA } from "./sharing/schema.js";
import {
  mkdirSync,
  chmodSync,
  readlinkSync,
  openSync,
  closeSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const LEASE_EXPIRY_MS = 120000;
const hostId = (() => {
  let namespace = "host";
  let boot: string;
  try {
    if (process.platform === "linux") {
      namespace = readlinkSync("/proc/self/ns/pid");
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else if (process.platform === "darwin")
      boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
    else throw new Error("Unverified boot identity");
    if (!boot) throw new Error("Empty boot identity");
  } catch {
    boot = `unverified:${randomUUID()}`;
  }
  return createHash("sha256")
    .update(`${process.platform}:${hostname()}:${boot}:${namespace}`)
    .digest("hex");
})();

async function copyDatabase(connection: DatabaseSync, destination: string) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(destination, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Backup destination already exists");
    throw error;
  }
  try {
    await backup(connection, destination);
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

export async function backupDatabase(source: string, destination: string) {
  const connection = new DatabaseSync(source, { readOnly: true });
  try {
    await copyDatabase(connection, destination);
  } finally {
    connection.close();
  }
}

export class Db {
  private static activeInstances = new Set<string>();
  private connection: DatabaseSync;
  private depth = 0;
  private activeOwner?: string;
  constructor(path: string, owner?: string) {
    if (path !== ":memory:" && !owner)
      throw new Error(
        "Persistent database writes require an instance lease owner",
      );
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.connection.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.connection.exec(
      "CREATE TABLE IF NOT EXISTS instance_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL,host_id TEXT,heartbeat_at INTEGER)",
    );
    try {
      if (owner) this.acquireInstance(owner);
      this.transaction(() => {
        this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'local', settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL, password TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS departments(id TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, parent_id TEXT, source TEXT NOT NULL DEFAULT 'local', external_id TEXT, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,external_id));
      CREATE TABLE IF NOT EXISTS members(tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, department_id TEXT, status TEXT NOT NULL DEFAULT 'active', seat INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'local', external_id TEXT, PRIMARY KEY(tenant_id,user_id), UNIQUE(tenant_id,external_id));
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tenant_id TEXT NOT NULL REFERENCES tenants(id), expires_at INTEGER NOT NULL, kind TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id,tenant_id);
      CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), state_hash TEXT UNIQUE NOT NULL, proof_hash TEXT NOT NULL, status TEXT NOT NULL, user_id TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS enterprise_auth(tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),corp_id TEXT NOT NULL,agent_id TEXT NOT NULL,credential_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integrations(tenant_id TEXT NOT NULL,kind TEXT NOT NULL,base_url TEXT NOT NULL,credential_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(tenant_id,kind));
      CREATE TABLE IF NOT EXISTS connector_sessions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_version INTEGER NOT NULL,remote_session TEXT,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, ciphertext TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), seats INTEGER NOT NULL, credits INTEGER NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, metering TEXT NOT NULL DEFAULT 'calendar');
      CREATE TABLE IF NOT EXISTS limits(tenant_id TEXT NOT NULL REFERENCES tenants(id), subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(tenant_id,subject_type,subject_id));
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), request_key TEXT NOT NULL, user_id TEXT NOT NULL, department_id TEXT, application TEXT NOT NULL, model_id TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL, reserved INTEGER NOT NULL, status TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, settled_at INTEGER, UNIQUE(tenant_id,request_key));
      CREATE INDEX IF NOT EXISTS ledger_period ON ledger(tenant_id,period,status);
      CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, scope TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 1, published_version INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS resources_kind ON resources(tenant_id,kind);
      CREATE TABLE IF NOT EXISTS resource_versions(resource_id TEXT NOT NULL REFERENCES resources(id), version INTEGER NOT NULL, data TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(resource_id,version));
      CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(tenant_id,kind,name));
      CREATE TABLE IF NOT EXISTS policies(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), family TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS policies_family ON policies(tenant_id,family);
      CREATE TABLE IF NOT EXISTS configurations(tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, draft TEXT NOT NULL, published TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(tenant_id,kind));
      CREATE TABLE IF NOT EXISTS configuration_history(tenant_id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,kind,version));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, target TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant_id,created_at);
      CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, application TEXT NOT NULL, model_id TEXT NOT NULL, status TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL, error_code TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_calls(tenant_id TEXT NOT NULL, request_key TEXT NOT NULL, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(tenant_id,request_key));
      CREATE TABLE IF NOT EXISTS client_events(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, event_key TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(tenant_id,user_id,event_key));
      CREATE TABLE IF NOT EXISTS runtime_sessions(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, error_code TEXT, timeout_ms INTEGER NOT NULL, trigger_key TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, UNIQUE(tenant_id,trigger_key));
      CREATE INDEX IF NOT EXISTS runs_queue ON runs(status,created_at);
      CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, agent_id TEXT NOT NULL, input TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_at INTEGER, ends_at INTEGER, webhook_credential_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, credential_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error_code TEXT, UNIQUE(run_id,credential_id));
      CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, cases TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, dataset_id TEXT NOT NULL, status TEXT NOT NULL, report TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE TABLE IF NOT EXISTS sandbox_runtimes(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),user_id TEXT NOT NULL,name TEXT NOT NULL,scope TEXT NOT NULL,owner_token TEXT NOT NULL,container_id TEXT,status TEXT NOT NULL,error_code TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS sandbox_runtime_tenant ON sandbox_runtimes(tenant_id,status);
      CREATE TABLE IF NOT EXISTS sandbox_executions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,runtime_id TEXT NOT NULL REFERENCES sandbox_runtimes(id),user_id TEXT NOT NULL,status TEXT NOT NULL,code TEXT NOT NULL,stdout TEXT,stderr TEXT,exit_code INTEGER,error_code TEXT,timeout_ms INTEGER NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS sandbox_execution_queue ON sandbox_executions(status,created_at);
      CREATE TABLE IF NOT EXISTS run_sandboxes(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,runtime_id TEXT NOT NULL UNIQUE REFERENCES sandbox_runtimes(id));
      CREATE TABLE IF NOT EXISTS run_tools(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,call_id TEXT NOT NULL,name TEXT NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,result TEXT,status TEXT NOT NULL,execution_id TEXT UNIQUE REFERENCES sandbox_executions(id) ON DELETE SET NULL,error_code TEXT,created_at INTEGER NOT NULL,finished_at INTEGER,PRIMARY KEY(run_id,call_id));
      CREATE TABLE IF NOT EXISTS run_connectors(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,asset_id TEXT NOT NULL,asset_version INTEGER NOT NULL,PRIMARY KEY(run_id,asset_id));
      CREATE TABLE IF NOT EXISTS remote_devices(tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,device_sid TEXT NOT NULL,device_mid TEXT NOT NULL,name TEXT,platform TEXT,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,device_sid));
      CREATE INDEX IF NOT EXISTS remote_devices_user ON remote_devices(tenant_id,user_id,expires_at);
      CREATE TABLE IF NOT EXISTS remote_pairings(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,device_sid TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,answered_at INTEGER);
      CREATE INDEX IF NOT EXISTS remote_pairings_pending ON remote_pairings(tenant_id,user_id,device_sid,status,created_at);
      INSERT OR IGNORE INTO schema_version VALUES(1,unixepoch()*1000);
      INSERT OR IGNORE INTO schema_version VALUES(2,unixepoch()*1000);
    `);
        for (const statement of SHARING_SCHEMA) this.run(statement);
        this.run(
          "INSERT OR IGNORE INTO schema_version VALUES(6,unixepoch()*1000)",
        );
        this.run(
          "INSERT OR IGNORE INTO schema_version VALUES(7,unixepoch()*1000)",
        );
        if (
          !this.all<{ name: string }>("PRAGMA table_info(runs)").some(
            (column) => column.name === "cancel_requested",
          )
        )
          this.connection.exec(
            "ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
          );
        this.run(
          "INSERT OR IGNORE INTO schema_version VALUES(4,unixepoch()*1000)",
        );
        for (const [name, declaration] of [
          ["kind", "TEXT NOT NULL DEFAULT 'sandbox'"],
          ["dispatched", "INTEGER NOT NULL DEFAULT 0"],
          ["asset_id", "TEXT"],
          ["asset_version", "INTEGER"],
          ["remote_name", "TEXT"],
        ])
          if (
            !this.all<{ name: string }>("PRAGMA table_info(run_tools)").some(
              (column) => column.name === name,
            )
          )
            this.connection.exec(
              `ALTER TABLE run_tools ADD COLUMN ${name} ${declaration}`,
            );
        this.run(
          "INSERT OR IGNORE INTO schema_version VALUES(5,unixepoch()*1000)",
        );
        for (const [name, declaration] of [
          ["run_id", "TEXT REFERENCES runs(id) ON DELETE CASCADE"],
          // 连接器会话记录远端协商版本：代理后续请求必须回放同一版本，
          // 不能对已协商的连接固定发送另一个版本。
          ["protocol_version", "TEXT"],
        ])
          if (
            !this.all<{ name: string }>(
              "PRAGMA table_info(connector_sessions)",
            ).some((column) => column.name === name)
          )
            this.connection.exec(
              `ALTER TABLE connector_sessions ADD COLUMN ${name} ${declaration}`,
            );
      });
      if (
        this.all<{ name: string }>("PRAGMA table_info(instance_lease)").some(
          (column) => column.name === "host_id",
        )
      )
        this.run(
          "INSERT OR IGNORE INTO schema_version VALUES(3,unixepoch()*1000)",
        );
    } catch (error) {
      if (this.activeOwner) this.releaseInstance(this.activeOwner);
      this.connection.close();
      throw error;
    }
  }
  run(sql: string, ...params: SQLInputValue[]) {
    if (this.activeOwner && this.depth === 0)
      return this.transaction(() =>
        this.connection.prepare(sql).run(...params),
      );
    this.assertInstance();
    return this.connection.prepare(sql).run(...params);
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection.prepare(sql).all(...params) as T[];
  }
  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `sp_${this.depth}`;
    this.connection.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      this.assertInstance();
      const result = fn();
      this.connection.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      if (nested) {
        this.connection.exec(`ROLLBACK TO ${savepoint}`);
        this.connection.exec(`RELEASE ${savepoint}`);
      } else this.connection.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }
  close() {
    if (this.activeOwner) this.releaseInstance(this.activeOwner);
    this.connection.close();
  }
  acquireInstance(owner: string) {
    this.transaction(() => {
      const previous = this.get<{
        owner: string;
        pid: number;
        host_id?: string;
        heartbeat_at?: number;
      }>("SELECT * FROM instance_lease WHERE id=1");
      if (previous) {
        if (previous.host_id !== hostId) {
          if (
            !previous.heartbeat_at ||
            Date.now() - previous.heartbeat_at < LEASE_EXPIRY_MS
          )
            throw new Error(
              "Database belongs to another or legacy namespace; stop its backend before migration or wait for the foreign lease to expire",
            );
        } else {
          let alive =
            previous.pid !== process.pid ||
            Db.activeInstances.has(previous.owner);
          try {
            process.kill(previous.pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH")
              alive = false;
          }
          if (alive)
            throw new Error(
              "Database already belongs to a running backend instance",
            );
        }
      }
      const columns = this.all<{ name: string }>(
        "PRAGMA table_info(instance_lease)",
      );
      if (!columns.some((column) => column.name === "host_id"))
        this.connection.exec(
          "ALTER TABLE instance_lease ADD COLUMN host_id TEXT",
        );
      if (!columns.some((column) => column.name === "heartbeat_at"))
        this.connection.exec(
          "ALTER TABLE instance_lease ADD COLUMN heartbeat_at INTEGER",
        );
      this.run(
        "INSERT INTO instance_lease(id,owner,pid,host_id,heartbeat_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,host_id=excluded.host_id,heartbeat_at=excluded.heartbeat_at",
        owner,
        process.pid,
        hostId,
        Date.now(),
      );
    });
    Db.activeInstances.add(owner);
    this.activeOwner = owner;
  }
  assertInstance() {
    if (
      this.activeOwner &&
      this.get<{ owner: string }>("SELECT owner FROM instance_lease WHERE id=1")
        ?.owner !== this.activeOwner
    )
      throw new Error("Database instance lease lost");
  }
  renewInstance(owner: string) {
    const result = this.connection
      .prepare(
        "UPDATE instance_lease SET heartbeat_at=? WHERE id=1 AND owner=?",
      )
      .run(Date.now(), owner);
    if (result.changes !== 1) throw new Error("Database instance lease lost");
  }
  releaseInstance(owner: string) {
    this.connection
      .prepare("DELETE FROM instance_lease WHERE id=1 AND owner=?")
      .run(owner);
    Db.activeInstances.delete(owner);
    if (this.activeOwner === owner) this.activeOwner = undefined;
  }
  async backupTo(destination: string) {
    await copyDatabase(this.connection, destination);
  }
}
