import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * 本合同测试只读取仓库内的部署资产，并让 Docker Compose 自己完成 YAML 解析。
 * 测试注入的值全部是公开假数据；真实数据库、Telegram 或 Docker Hub 凭据不得进入测试进程、失败输出或快照。
 */
const repositoryRoot = resolve(import.meta.dirname, "..");
const requiredAssets = [
  "Dockerfile",
  ".dockerignore",
  ".env.example",
  "docker-compose.prod.yml",
  "docker-compose.dev.yml",
  "docker/postgres/init-app-role.sh",
];
const assetsExist = requiredAssets.every((path) =>
  existsSync(resolve(repositoryRoot, path)));

test("提供完整的 Docker 运行合同资产", () => {
  const missing = requiredAssets.filter((path) =>
    !existsSync(resolve(repositoryRoot, path)));
  assert.deepEqual(
    missing,
    [],
    `缺少 Docker 运行合同资产：${missing.join(", ")}`,
  );
});

/**
 * 资产缺失时只保留上方单一有效 RED，避免后续读取错误掩盖“尚未实现 Docker 合同”这一真实原因。
 * 资产出现后这些测试自动解除跳过并验证可观察的 Compose/Docker 构建边界。
 */
const contractTest = (name, implementation) =>
  test(name, { skip: !assetsExist }, implementation);

contractTest("Dockerfile 使用 Node 22 多阶段 glibc 构建并只交付生产运行资产", () => {
  const dockerfile = readAsset("Dockerfile");
  const instructions = stripDockerComments(dockerfile);

  assert.match(instructions, /FROM\s+node:22(?:[.\w-]*)-bookworm-slim\s+AS\s+dependencies/i);
  assert.match(instructions, /FROM\s+node:22(?:[.\w-]*)-bookworm-slim\s+AS\s+production-dependencies/i);
  assert.match(instructions, /FROM\s+node:22(?:[.\w-]*)-bookworm-slim\s+AS\s+runtime/i);
  assert.doesNotMatch(instructions, /\balpine\b/i);
  assert.ok(
    (instructions.match(/\bRUN\s+npm ci\b/g) ?? []).length >= 2,
    "完整依赖和生产依赖阶段都必须使用 lockfile 驱动的 npm ci",
  );
  assert.doesNotMatch(instructions, /\bnpm install\b/);
  assert.match(instructions, /\bRUN\s+npm run build\b/);
  assert.match(instructions, /COPY\s+--from=build\s+\/app\/dist\/client\s+\.\/dist\/client/i);
  assert.match(instructions, /COPY\s+--from=build\s+\/app\/dist\/server\s+\.\/dist\/server/i);
  assert.match(instructions, /COPY\s+--from=production-dependencies\s+\/app\/node_modules\s+\.\/node_modules/i);
  assert.match(instructions, /COPY\s+migrations\/postgres\s+\.\/migrations\/postgres/i);
  assert.doesNotMatch(instructions, /\bCOPY\s+\.\s+\./);
});

contractTest("Dockerfile 安装锁定 Playwright Chromium，且不硬编码 CPU 架构下载", () => {
  const dockerfile = readAsset("Dockerfile");
  const instructions = stripDockerComments(dockerfile);
  const packageJson = JSON.parse(readAsset("package.json"));

  assert.match(packageJson.dependencies.playwright, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.dependencies.playwright, "1.62.0");
  assert.match(instructions, /\bPLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(
    instructions,
    /\bnpx\s+--no-install\s+playwright\s+install\s+--with-deps\s+chromium\b/,
  );
  assert.doesNotMatch(
    instructions,
    /\b(?:linux\/)?(?:amd64|arm64|x86_64|aarch64)\b/i,
  );
  assert.doesNotMatch(instructions, /https?:\/\/\S*(?:chromium|chrome)/i);
});

contractTest("Docker runtime 使用固定非 root 身份、init 和最小 HTTP 健康边界", () => {
  const instructions = stripDockerComments(readAsset("Dockerfile"));
  const exposeLines = instructions.match(/^EXPOSE\s+.+$/gim) ?? [];

  assert.match(instructions, /\b(?:useradd|adduser)\b[\s\S]*(?:10001)/i);
  assert.match(instructions, /^USER\s+(?:10001|app)\b/im);
  assert.match(instructions, /ENTRYPOINT\s+\["\/usr\/bin\/tini",\s*"--"\]/);
  assert.match(instructions, /HEALTHCHECK[\s\S]*127\.0\.0\.1[\s\S]*\/api\/health/i);
  assert.deepEqual(exposeLines.map((line) => line.trim()), ["EXPOSE 3000"]);
  assert.match(instructions, /CMD\s+\["node",\s*"dist\/server\/index\.js"\]/);
  assert.match(instructions, /\bHOME=\/home\/app/);
  assert.match(instructions, /TMPDIR=\/tmp\/switch-price-monitor/);
  assert.doesNotMatch(instructions, /\b(?:9222|9223|5432)\b/);
});

contractTest("Dockerfile 不接受秘密构建参数", () => {
  const instructions = stripDockerComments(readAsset("Dockerfile"));
  const argumentsList = [...instructions.matchAll(/^ARG\s+([A-Z0-9_]+)/gim)]
    .map((match) => match[1]);

  assert.ok(
    argumentsList.every((name) =>
      !/(?:PASSWORD|TOKEN|SECRET|COOKIE|DATABASE|TELEGRAM|CREDENTIAL|SESSION)/i.test(name)),
    `禁止的秘密 ARG：${argumentsList.join(", ")}`,
  );
});

contractTest("生产 Compose 只有 app 与 postgres，且镜像版本必填并禁止本地构建", () => {
  const source = readAsset("docker-compose.prod.yml");
  const compose = parseCompose("docker-compose.prod.yml");

  assert.deepEqual(Object.keys(compose.services).sort(), ["app", "postgres"]);
  assert.equal(compose.services.app.image, "example/switch-price-monitor:0.1.0");
  assert.equal("build" in compose.services.app, false);
  assert.equal("build" in compose.services.postgres, false);
  assert.match(source, /image:\s*["']?\$\{DOCKERHUB_IMAGE\}:\$\{APP_VERSION\}["']?/);
  assert.match(source, /\$\{APP_VERSION:\?[^}]+\}/);
  assert.doesNotMatch(source, /APP_VERSION(?::-|=)latest/i);
});

contractTest("生产 Compose 只发布应用 HTTP，PostgreSQL 17 保持内部可达", () => {
  const compose = parseCompose("docker-compose.prod.yml");
  const app = compose.services.app;
  const postgres = compose.services.postgres;

  assert.equal(postgres.image, "postgres:17");
  assert.equal("ports" in postgres, false);
  // Compose 规范化 JSON 将 expose 保留为字符串；转为数字后验证容器端口语义，避免测试绑定序列化细节。
  assert.deepEqual(postgres.expose.map(Number), [5432]);
  assert.equal(app.ports.length, 1);
  assert.equal(Number(app.ports[0].published), 4300);
  assert.equal(Number(app.ports[0].target), 3000);
  assert.ok(
    Object.entries(compose.services)
      .filter(([, service]) => "ports" in service)
      .every(([name]) => name === "app"),
    "app 必须是唯一拥有 host ports 的常驻服务",
  );
  assert.ok(
    app.ports.every((port) => ![5432, 9222, 9223].includes(Number(port.target))),
    "不得发布 PostgreSQL 或 Chromium 调试端口",
  );
});

contractTest("生产服务具备健康依赖、重启、init、非 root 与持久化边界", () => {
  const compose = parseCompose("docker-compose.prod.yml");
  const app = compose.services.app;
  const postgres = compose.services.postgres;

  for (const service of [app, postgres]) {
    assert.equal(service.restart, "unless-stopped");
    assert.ok(service.healthcheck?.test, "两个常驻服务都必须配置健康检查");
  }
  assert.equal(app.init, true);
  assert.equal(app.user, "10001:10001");
  assert.equal(app.depends_on.postgres.condition, "service_healthy");
  assert.equal(postgres.volumes.length, 2);
  const dataMount = postgres.volumes.find((mount) =>
    mount.target === "/var/lib/postgresql/data");
  const initMount = postgres.volumes.find((mount) =>
    mount.target === "/docker-entrypoint-initdb.d/010-init-app-role.sh");
  assert.equal(dataMount.type, "bind");
  assert.equal(dataMount.source, "/tmp/switch-price-monitor-contract/postgres");
  assert.equal(initMount.type, "bind");
  assert.ok(initMount.source.endsWith("/docker/postgres/init-app-role.sh"));
  assert.equal(initMount.read_only, true);
  assert.equal(compose.volumes, undefined);
});

contractTest("生产 bootstrap 管理角色与普通应用角色严格分离", () => {
  const compose = parseCompose("docker-compose.prod.yml");
  const appEnvironment = compose.services.app.environment;
  const databaseEnvironment = compose.services.postgres.environment;
  const example = parseEnvExample(readAsset(".env.example"));

  assert.equal(appEnvironment.DATABASE_URL, fixtureEnvironment.DATABASE_URL);
  assert.equal(appEnvironment.COOKIE_SECURE, "false");
  assert.equal(appEnvironment.TELEGRAM_BOT_TOKEN, "");
  assert.equal(appEnvironment.TELEGRAM_CHAT_ID, "");
  assert.equal(databaseEnvironment.POSTGRES_DB, fixtureEnvironment.POSTGRES_DB);
  assert.equal(databaseEnvironment.POSTGRES_USER, fixtureEnvironment.POSTGRES_USER);
  assert.equal(databaseEnvironment.POSTGRES_PASSWORD, fixtureEnvironment.POSTGRES_PASSWORD);
  assert.equal(databaseEnvironment.APP_DATABASE_USER, fixtureEnvironment.APP_DATABASE_USER);
  assert.equal(
    databaseEnvironment.APP_DATABASE_PASSWORD,
    fixtureEnvironment.APP_DATABASE_PASSWORD,
  );
  for (const forbidden of [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "APP_DATABASE_USER",
    "APP_DATABASE_PASSWORD",
  ]) {
    assert.equal(
      forbidden in appEnvironment,
      false,
      `app 容器不得获得 bootstrap 或数据库原始凭据：${forbidden}`,
    );
  }
  assert.notEqual(example.POSTGRES_USER, example.APP_DATABASE_USER);
  assert.notEqual(example.POSTGRES_USER.toLowerCase(), "postgres");
  assert.notEqual(example.APP_DATABASE_USER.toLowerCase(), "postgres");
  assert.match(example.DATABASE_URL, /^postgres(?:ql)?:\/\/switch_price_monitor:/);
  assert.match(example.DATABASE_URL, /@postgres:5432\/switch_price_monitor$/);
  assertOrdinaryRoleHealthcheck(compose.services.postgres);
});

contractTest("开发 Compose 使用隔离双角色并只在回环发布 PostgreSQL 17 测试端口", () => {
  const compose = parseCompose("docker-compose.dev.yml");
  const postgres = compose.services.postgres;

  assert.equal(postgres.image, "postgres:17");
  assert.equal(postgres.ports.length, 1);
  assert.equal(postgres.ports[0].host_ip, "127.0.0.1");
  assert.equal(Number(postgres.ports[0].published), 54329);
  assert.equal(Number(postgres.ports[0].target), 5432);
  assert.equal(postgres.environment.POSTGRES_DB, "switch_test");
  assert.equal(postgres.environment.POSTGRES_USER, "switch_test_admin");
  assert.equal(postgres.environment.APP_DATABASE_USER, "switch_test");
  assert.notEqual(
    postgres.environment.POSTGRES_USER,
    postgres.environment.APP_DATABASE_USER,
  );
  assert.ok(postgres.tmpfs.includes("/var/lib/postgresql/data"));
  const initMount = postgres.volumes.find((mount) =>
    mount.target === "/docker-entrypoint-initdb.d/010-init-app-role.sh");
  assert.ok(initMount.source.endsWith("/docker/postgres/init-app-role.sh"));
  assert.equal(initMount.read_only, true);
  assertOrdinaryRoleHealthcheck(postgres);
});

contractTest("PostgreSQL init hook 在单事务内安全创建最小权限应用角色", () => {
  const script = readAsset("docker/postgres/init-app-role.sh");
  const adminPasswordGuard = script.indexOf(
    ': "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD_REQUIRED}"',
  );
  const distinctPasswordGuard = script.indexOf(
    '[[ "${POSTGRES_PASSWORD}" != "${APP_DATABASE_PASSWORD}" ]] || exit 1',
  );
  const psqlInvocation = script.indexOf("\npsql ");

  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /\bset -Eeuo pipefail\b/);
  assert.doesNotMatch(script, /\bset\s+-x\b|\becho\b|\bprintf\b/);
  assert.ok(adminPasswordGuard >= 0, "init hook 必须拒绝缺失 bootstrap 管理密码");
  assert.ok(distinctPasswordGuard >= 0, "init hook 必须拒绝 admin/app 复用同一密码");
  assert.ok(
    adminPasswordGuard < psqlInvocation && distinctPasswordGuard < psqlInvocation,
    "密码存在性与隔离检查必须在任何 psql/SQL 前完成",
  );
  assert.match(script, /\bBEGIN;/);
  assert.match(script, /\bCOMMIT;/);
  assert.match(
    script,
    /CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(script, /format\([\s\S]*%I[\s\S]*%L/);
  assert.match(script, /ALTER DATABASE %I OWNER TO %I/);
  assert.match(script, /ALTER SCHEMA public OWNER TO %I/);
  // psql 从环境写入内部变量，密码不会像 --set=secret=... 那样出现在进程命令行。
  assert.match(script, /\\getenv app_database_user APP_DATABASE_USER/);
  assert.match(script, /\\getenv app_database_password APP_DATABASE_PASSWORD/);
  assert.doesNotMatch(script, /--set=app_database_password=/);
  assert.doesNotMatch(script, /\$\{?APP_DATABASE_PASSWORD\}?[^"\n]*>\s*\//);
});

contractTest(".dockerignore 排除源码控制、秘密、测试和本地数据但保留构建输入", () => {
  const patterns = readAsset(".dockerignore")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const requiredExclusions = [
    ".git",
    ".worktrees",
    ".github",
    ".env",
    ".env.*",
    "node_modules",
    "dist",
    "coverage",
    "test",
    "docs",
    "docker/postgres",
    "postgres-data",
    "backups",
    "*.log",
    "*.pem",
    "*.key",
  ];

  for (const exclusion of requiredExclusions) {
    assert.ok(patterns.includes(exclusion), `缺少构建上下文排除项：${exclusion}`);
  }
  assert.ok(patterns.includes("!.env.example"), "必须允许提交的安全环境变量示例");
  for (const requiredInput of [
    "src",
    "migrations",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "tsup.config.ts",
    "index.html",
  ]) {
    assert.equal(patterns.includes(requiredInput), false, `误排除必要构建输入：${requiredInput}`);
  }
});

contractTest(".env.example 提供固定版本和全部安全占位而不携带真实秘密", () => {
  const example = parseEnvExample(readAsset(".env.example"));
  const expectedKeys = [
    "DOCKERHUB_IMAGE",
    "APP_VERSION",
    "APP_PORT",
    "PORT",
    "DATABASE_URL",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "APP_DATABASE_USER",
    "APP_DATABASE_PASSWORD",
    "POSTGRES_DATA_DIR",
    "COOKIE_SECURE",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "BACKUP_DIR",
    "BACKUP_RETENTION",
    "MAXIMUM_BODY_BYTES",
    "SHUTDOWN_GRACE_MS",
  ];

  for (const key of expectedKeys) {
    assert.ok(key in example, `环境变量示例缺少 ${key}`);
  }
  assert.match(example.APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.notEqual(example.APP_VERSION, "latest");
  assert.equal(example.COOKIE_SECURE, "false");
  assert.equal(example.TELEGRAM_BOT_TOKEN, "");
  assert.equal(example.TELEGRAM_CHAT_ID, "");
  assert.notEqual(example.POSTGRES_USER, example.APP_DATABASE_USER);
  assert.notEqual(example.POSTGRES_PASSWORD, example.APP_DATABASE_PASSWORD);
  assert.match(example.POSTGRES_PASSWORD, /replace|替换/i);
  assert.match(example.APP_DATABASE_PASSWORD, /replace|替换/i);
  assert.match(example.DATABASE_URL, /replace|替换/i);
});

contractTest("package 脚本让 Docker 与平台移除静态门禁共享 CI 入口", () => {
  const packageJson = JSON.parse(readAsset("package.json"));

  // CI 已固定调用 test:docker-config；把平台移除合同并入同一 Node test 命令，才能保证普通 push
  // 与标签发布都在镜像构建前阻止旧运行时回流，而不必复制两份工作流步骤或执行顺序断言。
  assert.equal(
    packageJson.scripts["test:docker-config"],
    "node --test test/docker-config.test.mjs test/platform-removal.test.mjs",
  );
  assert.ok(
    Object.keys(packageJson.codexMetadata.dockerRuntimeConfigurationRationaleZh)
      .length >= 3,
    "必须记录镜像可复现性、秘密与双架构边界，避免 JSON 无注释导致约束丢失",
  );
  assert.deepEqual(
    Object.keys(packageJson.codexMetadata.platformRemovalGateRationaleZh).sort(),
    ["ci", "dependencies", "scope"],
    "必须记录平台门禁的扫描范围、传递依赖例外与 CI 接线理由，防止后续扩大扫描或绕过发布门禁",
  );
});

/** 读取失败只包含公开相对路径，不拼接环境变量、凭据或用户主目录。 */
function readAsset(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

/** Docker 指令检查忽略中文说明，防止注释中的 arm64/amd64 验收文字被误判成硬编码下载。 */
function stripDockerComments(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * 使用 Compose 官方解析器取得规范化 JSON；只继承 PATH，杜绝开发机真实环境值意外覆盖假数据或进入失败输出。
 * 这验证的是 Compose 的实际插值、端口、bind mount 与依赖语义，而不是测试自行模拟 YAML。
 */
function parseCompose(relativePath) {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      resolve(repositoryRoot, relativePath),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ...fixtureEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output);
}

/** `.env.example` 只允许普通 KEY=VALUE；不执行 shell、变量替换或命令替换，避免示例文本获得执行能力。 */
function parseEnvExample(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        assert.ok(separator > 0, `无效的 .env.example 行：${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

/** 合同值刻意不可用于真实服务，且不包含仓库外秘密；测试失败也可安全展示这些值。 */
const fixtureEnvironment = {
  DOCKERHUB_IMAGE: "example/switch-price-monitor",
  APP_VERSION: "0.1.0",
  APP_PORT: "4300",
  PORT: "3000",
  DATABASE_URL:
    "postgresql://switch_price_monitor:replace_with_url_encoded_password@postgres:5432/switch_monitor",
  POSTGRES_DB: "switch_monitor",
  POSTGRES_USER: "switch_price_bootstrap",
  POSTGRES_PASSWORD: "replace_with_random_admin_password",
  APP_DATABASE_USER: "switch_price_monitor",
  APP_DATABASE_PASSWORD: "replace_with_random_app_password",
  POSTGRES_DATA_DIR: "/tmp/switch-price-monitor-contract/postgres",
  COOKIE_SECURE: "false",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  MAXIMUM_BODY_BYTES: "1048576",
  SHUTDOWN_GRACE_MS: "10000",
};

/**
 * PostgreSQL healthy 必须由普通应用角色经 Compose 服务名进入容器网络 SCRAM 规则后自证权限，不能由本机 trust 或 bootstrap 代查目录。
 * 这样错误的 APP_DATABASE_PASSWORD、未创建普通角色或误授超级权限都会阻止 app 启动，而健康命令不会输出密码。
 */
function assertOrdinaryRoleHealthcheck(postgresService) {
  const healthCommand = postgresService.healthcheck.test.join(" ");

  assert.match(healthCommand, /PGPASSWORD=[^\s]*APP_DATABASE_PASSWORD/);
  assert.match(healthCommand, /--username[^\n]*APP_DATABASE_USER/);
  // 官方镜像把 local/127/::1 配为 trust；只有经 Compose 服务名进入容器网络 host 规则才会实际验证 SCRAM 密码。
  assert.match(healthCommand, /--host\s+postgres\b/);
  assert.doesNotMatch(
    healthCommand,
    /--host\s+(?:127\.0\.0\.1|localhost|::1)|\/var\/run\/postgresql/,
  );
  assert.match(healthCommand, /current_user/);
  assert.match(healthCommand, /WHERE rolname = current_user/);
  assert.match(
    healthCommand,
    /rolcanlogin[\s\S]*rolsuper[\s\S]*rolcreaterole[\s\S]*rolcreatedb[\s\S]*rolreplication[\s\S]*rolbypassrls/,
  );
  assert.doesNotMatch(healthCommand, /--username[^\n]*POSTGRES_USER/);
}
