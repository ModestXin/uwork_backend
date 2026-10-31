#!/usr/bin/env node
/**
 * 把 clients/uwork 相对 UWork 基线（v3.16.0）的适配补丁移植到目标客户端工作树。
 *
 * 现状：后台的客户端适配建立在 clients/uwork（UWork 3.16.0 整树副本）里，
 * 而主开发仓是 UWork-frontend（0.1.x）。本工具把两侧差异做成可复现的移植：
 *
 *   - 新增文件（基线没有、clients/uwork 有）：复制；目标已存在则记为 collision，不覆盖
 *   - 修改文件：对 (目标, 基线, 适配) 做三方合并；干净合并写回，冲突只报告不落盘
 *
 * 用法：
 *   git -C <UWork 仓库> archive v3.16.0 | tar -x -C /tmp/uwork-base-3.16.0
 *   node scripts/port-client-adaptation.mjs \
 *     --baseline /tmp/uwork-base-3.16.0 --target <UWork-frontend 工作树> \
 *     --report docs/integration/adaptation-patch-report.json          # 干跑
 *   node scripts/port-client-adaptation.mjs --baseline ... --target ... --apply
 *
 * 冲突文件的语义取舍按 docs/integration/dev-system-integration-plan-2026-10-31.md 处理。
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDED = new Set([".git", "node_modules", "dist", "evidence", ".release-config", "coverage"]);

// 输出被 head 等提前关闭时不要把 EPIPE 当成移植失败。
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});

function parseArguments(argv) {
  const options = { apply: false, adapted: join(REPOSITORY, "clients", "uwork"), raw: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--baseline") options.raw.baseline = argv[++index];
    else if (value === "--adapted") options.raw.adapted = argv[++index];
    else if (value === "--target") options.raw.target = argv[++index];
    else if (value === "--report") options.report = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const required of ["baseline", "target"]) {
    if (!options.raw[required]) throw new Error(`--${required} is required`);
    if (!statSync(options.raw[required]).isDirectory()) {
      throw new Error(`--${required} is not a directory: ${options.raw[required]}`);
    }
  }
  options.adapted = options.raw.adapted ?? options.adapted;
  if (!statSync(options.adapted).isDirectory()) {
    throw new Error(`--adapted is not a directory: ${options.adapted}`);
  }
  options.baseline = resolve(options.raw.baseline);
  options.adapted = resolve(options.adapted);
  options.target = resolve(options.raw.target);
  return options;
}

function walk(root, directory = root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(root, absolute, files);
    else if (entry.isFile()) files.push(relative(root, absolute));
  }
  return files;
}

function isBinary(path) {
  const buffer = readFileSync(path);
  return buffer.includes(0);
}

function sameBytes(left, right) {
  return Buffer.compare(readFileSync(left), readFileSync(right)) === 0;
}

/** 返回合并后的文本，冲突时返回 null。临时文件放在独立目录，不改动目标工作树。 */
function mergeCleanly(base, target, adapted, scratch) {
  if (isBinary(base) || isBinary(target) || isBinary(adapted)) return null;
  const working = join(scratch, "merged");
  copyFileSync(target, working);
  const run = spawnSync("git", ["merge-file", "--diff3", working, base, adapted], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) return null;
  return readFileSync(working, "utf8");
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const scratch = mkdtempSync(join(tmpdir(), "port-adaptation-"));
  const additions = [];
  const cleanMerges = [];
  const conflicts = [];
  const collisions = [];
  const binaryDiffs = [];
  const absentInTarget = [];
  try {
    for (const path of walk(options.adapted)) {
      const basePath = join(options.baseline, path);
      const adaptedPath = join(options.adapted, path);
      const targetPath = join(options.target, path);
      if (!existsSync(basePath)) {
        if (existsSync(targetPath)) collisions.push(path);
        else additions.push(path);
        continue;
      }
      // 适配副本里与基线逐字节相同的文件不是补丁，跳过。
      if (sameBytes(basePath, adaptedPath)) continue;
      if (!existsSync(targetPath)) {
        absentInTarget.push(path);
        continue;
      }
      if (sameBytes(basePath, targetPath)) {
        if (options.apply) {
          mkdirSync(dirname(targetPath), { recursive: true });
          copyFileSync(adaptedPath, targetPath);
        }
        cleanMerges.push(path);
        continue;
      }
      if (isBinary(basePath) || isBinary(targetPath) || isBinary(adaptedPath)) {
        binaryDiffs.push(path);
        continue;
      }
      const merged = mergeCleanly(basePath, targetPath, adaptedPath, scratch);
      if (merged === null) {
        conflicts.push(path);
        continue;
      }
      cleanMerges.push(path);
      if (options.apply) writeFileSync(targetPath, merged);
    }
    if (options.apply) {
      for (const path of additions) {
        const targetPath = join(options.target, path);
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(join(options.adapted, path), targetPath);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    // 记录命令行原文，避免把本机绝对路径写进提交物。
    baseline: options.raw.baseline,
    adapted: options.raw.adapted ?? "clients/uwork",
    target: options.raw.target,
    apply: options.apply,
    counts: {
      additions: additions.length,
      cleanMerges: cleanMerges.length,
      conflicts: conflicts.length,
      collisions: collisions.length,
      binaryDiffs: binaryDiffs.length,
      absentInTarget: absentInTarget.length,
    },
    additions,
    cleanMerges,
    conflicts,
    collisions,
    binaryDiffs,
    absentInTarget,
  };
  if (options.report) {
    const reportPath = resolve(options.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const lines = [
    `added: ${additions.length}  clean-merge: ${cleanMerges.length}  conflict: ${conflicts.length}  collision: ${collisions.length}`,
    options.apply ? "applied (conflict files untouched)" : "dry-run (no files written)",
    options.report ? `report: ${options.report}` : "",
    ...(conflicts.length ? ["conflicts:", ...conflicts.map((path) => `  ${path}`)] : []),
  ];
  process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
}

main();
