import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

/**
 * 最终平台移除门禁只检查仍会参与安装、构建、测试或部署的资产，不扫描 docs、Git 历史、
 * node_modules 或质量报告。历史 ADR 可以保留迁移背景；依赖 pg 合法携带的 pg-cloudflare
 * 也不是本项目主动选择的 Worker 运行时，因此禁止项必须由精确包名或精确运行时符号构成。
 */
const repositoryRoot = resolve(import.meta.dirname, "..");
const combine = (...parts) => parts.join("");
const forbiddenPackages = [
  combine("@cloud", "flare/vite-plugin"),
  combine("@cloud", "flare/vitest-pool-workers"),
  combine("@cloud", "flare/workers-types"),
  combine("@cloud", "flare/playwright"),
  combine("wrang", "ler"),
];
const forbiddenRuntimeReferences = [
  ...forbiddenPackages,
  combine("cloud", "flare:test"),
  combine("D1", "Database"),
  combine("Exported", "Handler"),
  combine("Browser", "Worker"),
];

/**
 * 这些目录是当前支持路径的可执行输入：src 是生产代码，test 是持续集成测试，scripts/docker 是
 * 运维与初始化脚本，migrations/postgres 会进入镜像并改写 schema，工作流是安装/构建/发布入口。
 * 扩展名白名单避免读取二进制或临时产物；根配置单独列举，防止未来目录扩张把缓存、报告或本机秘密误纳入失败输出。
 */
const scannedDirectories = ["src", "test", "scripts", ".github/workflows", "docker", "migrations/postgres"];
const scannedExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".sql",
  ".yml",
  ".yaml",
  ".sh",
]);
const scannedRootFiles = [
  "Dockerfile",
  ".dockerignore",
  ".env.example",
  "docker-compose.dev.yml",
  "docker-compose.prod.yml",
  "tsconfig.json",
  "tsup.config.ts",
  "vite.config.ts",
  "vitest.config.mts",
  "vitest.dom.config.mts",
];

/**
 * Task 11 完成后这些文件不能只是“未被 import”：它们本身代表第二套 D1 schema、仓储实现、
 * Worker 生命周期或旧发布入口。普通业务测试可在原文件中改写为 PostgreSQL 测试，所以下面
 * 只强制删除纯平台资产；所有其余测试仍由上方符号扫描证明不再依赖旧运行时。
 */
const obsoletePlatformAssets = [
  "src/worker/index.ts",
  combine("wrang", "ler.jsonc"),
  "scripts/deploy-production.mjs",
  "test/apply-migrations.ts",
  "test/environment.d.ts",
  "test/deploy-production-script.test.mjs",
  "test/worker-maintenance.test.ts",
  "migrations/0001_core.sql",
  "migrations/0002_price_tracking.sql",
  "migrations/0003_auth.sql",
  "migrations/0004_manual_refresh.sql",
  "migrations/0005_subscription_confirmation.sql",
  "migrations/0006_immediate_manual_refresh.sql",
  "src/repositories/auth-repository.ts",
  "src/repositories/collection-repository.ts",
  "src/repositories/dashboard-repository.ts",
  "src/repositories/exchange-rate-repository.ts",
  "src/repositories/export-repository.ts",
  "src/repositories/history-repository.ts",
  "src/repositories/manual-refresh-repository.ts",
  "src/repositories/notification-event-repository.ts",
  "src/repositories/price-repository.ts",
  "src/repositories/product-health-repository.ts",
  "src/repositories/retention-repository.ts",
  "src/repositories/settings-repository.ts",
  "src/repositories/subscription-confirmation-repository.ts",
  "src/repositories/subscription-detail-repository.ts",
  "src/repositories/subscription-repository.ts",
];

test("平台扫描覆盖 Docker 初始化资产与当前 PostgreSQL 迁移", () => {
  // init hook 和迁移 SQL 会直接进入 NAS 部署/运行镜像；若只扫描 src/test，旧 Binding 或 D1 类型可从这两个目录回流而绕过 CI。
  assert.deepEqual(
    scannedDirectories.filter((path) => path === "docker" || path === "migrations/postgres"),
    ["docker", "migrations/postgres"],
  );
  assert.ok(
    collectScannableFiles(resolve(repositoryRoot, "migrations/postgres"))
      .some((file) => relative(repositoryRoot, file) === "migrations/postgres/0001_initial.sql"),
    "平台门禁必须实际读取当前 PostgreSQL 迁移 SQL，不能只声明目录后被扩展名白名单静默跳过",
  );
});

test("package 与 lockfile 不再安装旧平台工具链", () => {
  const manifest = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const findings = [];

  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const packageName of forbiddenPackages) {
      if (Object.hasOwn(manifest[section] ?? {}, packageName)) {
        findings.push(`package.json ${section}: ${packageName}`);
      }
      if (Object.hasOwn(lockfile.packages?.[""]?.[section] ?? {}, packageName)) {
        findings.push(`package-lock.json root ${section}: ${packageName}`);
      }
    }
  }

  for (const packagePath of findForbiddenLockfilePackages(lockfile.packages ?? {})) {
    findings.push(`package-lock.json package: ${packagePath}`);
  }

  assert.deepEqual(
    findings,
    [],
    `仍安装旧平台工具链：\n${findings.join("\n")}`,
  );
});

test("lockfile 扫描也拒绝被其他依赖嵌套安装的旧平台工具链", () => {
  /**
   * npm lockfile 会把依赖私有版本记录为 `node_modules/<父包>/node_modules/<子包>`；
   * 只检查根层路径会让旧部署工具通过传递依赖重新进入 CI。合成清单同时保留合法的
  * `pg-cloudflare` 哨兵，证明扫描按精确包名判断而不是宽泛匹配平台字样。
  */
  const nestedCommandPackage = `node_modules/example-tool/node_modules/${forbiddenPackages[4]}`;
  const nestedPluginPackage = `node_modules/example-tool/node_modules/${forbiddenPackages[0]}`;
  const findings = findForbiddenLockfilePackages({
    [nestedCommandPackage]: {},
    [nestedPluginPackage]: {},
    "node_modules/pg-cloudflare": {},
  });

  assert.deepEqual(findings, [
    nestedCommandPackage,
    nestedPluginPackage,
  ]);
});

test("生产源码、测试和活跃配置不再引用旧平台运行时", () => {
  const findings = [];
  const files = [
    ...scannedRootFiles.map((path) => resolve(repositoryRoot, path)),
    ...scannedDirectories.flatMap((path) =>
      collectScannableFiles(resolve(repositoryRoot, path))),
  ];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const reference of forbiddenRuntimeReferences) {
      if (source.includes(reference)) {
        findings.push(`${relative(repositoryRoot, file)}: ${reference}`);
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `活跃资产仍引用旧平台运行时：\n${findings.join("\n")}`,
  );
});

test("D1 schema、仓储与 Worker 过渡入口已从支持路径移除", () => {
  const existing = obsoletePlatformAssets.filter((path) =>
    existsSync(resolve(repositoryRoot, path)));

  assert.deepEqual(
    existing,
    [],
    `以下旧平台资产仍然存在：\n${existing.join("\n")}`,
  );
});

/**
 * JSON 清单均为仓库内固定输入；解析失败必须作为配置错误直接暴露，不能退化成空对象从而
 * 跳过依赖检查。测试不读取环境变量，失败信息也只包含公开包名和相对路径。
 */
function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

/**
 * npm 既可把包提升到根 `node_modules`，也可在任意父依赖下保留私有版本；两种路径都必须按
 * 最后一个精确包名识别。这里不搜索普通子串，因此 `pg-cloudflare` 等名称相近但不在禁用清单
 * 的传递依赖不会被误报，失败信息也只公开 lockfile 中受版本控制的包路径。
 */
function findForbiddenLockfilePackages(packages) {
  const forbiddenSuffixes = forbiddenPackages.map((packageName) =>
    `node_modules/${packageName}`);
  return Object.keys(packages).filter((packagePath) =>
    forbiddenSuffixes.some((suffix) =>
      packagePath === suffix || packagePath.endsWith(`/${suffix}`)));
}

/**
 * 递归枚举只接受上方扩展名，且根目录缺失时返回空列表，使可选脚本目录调整不会引发 ENOENT；
 * 必须存在的单文件资产由既有构建/容器合同负责，平台门禁只判断旧运行时是否被重新接入。
 */
function collectScannableFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectScannableFiles(path);
    }
    return entry.isFile() && scannedExtensions.has(extname(entry.name))
      ? [path]
      : [];
  });
}
