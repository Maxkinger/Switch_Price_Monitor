import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";

/**
 * 此集成门禁只启动带唯一 Compose project 名的 postgres:17 临时栈，并把全部数据、Compose 文件和备份放在
 * task-9 专用 mkdtemp 目录。夹具密码均是不可用于生产的固定测试值，命令输出被捕获并脱敏，绝不读取 NAS、
 * Task 2/8 容器或开发机 `.env`；清理也只针对本测试自己创建的精确路径和 project 名。
 */
const repositoryRoot = resolve(import.meta.dirname, "..");
const backupScript = resolve(repositoryRoot, "scripts/backup-postgres.sh");
const restoreScript = resolve(repositoryRoot, "scripts/restore-postgres.sh");
const taskRoot = mkdtempSync(resolve(tmpdir(), "switch-price-monitor-task9-"));
const projectRoot = resolve(taskRoot, "project");
const backupDirectory = resolve(projectRoot, "backups");
const composeFile = resolve(projectRoot, "compose.yml");
const envFile = resolve(projectRoot, "task9.env");
const projectName = `switch-price-monitor-task9-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const databaseService = "database17";
const appService = "app";
const sourceDatabase = "task9_source";
const freshDatabase = "task9_fresh";
const fixtureDatabase = "task9_fixture";
const bootstrapOwnedDatabase = "task9_bootstrap_owned";
const viewOnlyDatabase = "task9_view_only";
const failedRestoreDatabase = "task9_restore_failure";
const checksumFailureDatabase = "task9_checksum_failure";
const adminFailureDatabase = "task9_admin_failure";
const coreTableFailureDatabase = "task9_core_failure";
const requiredTableFailureDatabase = "task9_required_table_failure";
const catalogGuardDatabase = "task9_catalog_guard";
// 所有数据库标识都是本测试内部固定、安全子集常量；辅助函数仍会校验它们，禁止未来把外部输入拼入 SQL 或文件名。
const sourceFileSegment = "task9_source";
const otherDatabaseSentinel = resolve(backupDirectory, "switch-price-monitor-task9_other-000000000000000001-20260729T000000Z.dump");

mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
writeFixtureCompose();

test.before(() => {
  // 脚本尚未实现时保留一个真正的 RED：失败只能来自缺失的运维入口，而不能因 Docker/测试夹具尚未启动而混淆原因。
  assert.equal(existsSync(backupScript), true, "缺少安全 PostgreSQL 备份脚本");
  assert.equal(existsSync(restoreScript), true, "缺少安全 PostgreSQL 恢复脚本");
});

test("恢复失败清理禁止使用会撤销共享对象授权的 DROP OWNED", () => {
  const restoreSource = readFileSync(restoreScript, "utf8");
  // PostgreSQL 17 合同规定 DROP OWNED 会撤销数据库、表空间和配置参数等共享对象授权；
  // 即使当前隔离镜像未复现撤权，生产脚本也必须使用只作用于显式目标数据库的 typed cleanup。
  assert.doesNotMatch(restoreSource, /\bDROP\s+OWNED\b/i);
  assert.match(restoreSource, /DROP\s+SCHEMA/i, "目标库清理必须显式删除用户 schema，而不是依赖角色级全局清理");
});

test("拒绝相对路径、项目根备份目录、符号链接逃逸和目录外归档", () => {
  const escapedBackup = resolve(projectRoot, "escape-backups");
  const outsideDump = resolve(taskRoot, "switch-price-monitor-task9_source-000000000000000001-20260729T000000Z.dump");
  symlinkSync(taskRoot, escapedBackup);
  writeFileSync(outsideDump, "outside", { mode: 0o600 });
  // 路径负例在 Compose/Docker 调用前失败，确保不会因为错误目录误碰现有项目或读取秘密环境。
  assert.throws(() => runScript(backupScript, ["--compose-file", composeFile, "--env-file", "task9.env", "--project-name", projectName, "--database-service", databaseService, "--database", sourceDatabase, "--project-root", projectRoot, "--backup-dir", backupDirectory, "--retention", "2"]), /绝对路径/);
  assert.throws(() => runScript(backupScript, ["--compose-file", composeFile, "--env-file", envFile, "--project-name", projectName, "--database-service", databaseService, "--database", sourceDatabase, "--project-root", ".", "--backup-dir", backupDirectory, "--retention", "2"]), /绝对路径/);
  assert.throws(() => runScript(backupScript, ["--compose-file", composeFile, "--env-file", envFile, "--project-name", projectName, "--database-service", databaseService, "--database", sourceDatabase, "--project-root", projectRoot, "--backup-dir", projectRoot, "--retention", "2"]), /严格子目录/);
  assert.throws(() => runScript(backupScript, ["--compose-file", composeFile, "--env-file", envFile, "--project-name", projectName, "--database-service", databaseService, "--database", sourceDatabase, "--project-root", projectRoot, "--backup-dir", escapedBackup, "--retention", "2"]), /严格子目录/);
  assert.throws(() => runScript(restoreScript, ["--compose-file", composeFile, "--env-file", envFile, "--project-name", projectName, "--app-service", appService, "--database-service", databaseService, "--project-root", projectRoot, "--backup-dir", backupDirectory, "--dump", outsideDump, "--database", freshDatabase]), /受控 custom archive/);
});

test("仅含迁移的 fresh 备份可恢复为空业务库", { timeout: 120_000 }, () => {
  startDatabase();
  createMigratedSchema();

  const freshDump = backup();
  assertCustomArchive(freshDump);
  createEmptyDatabase(freshDatabase);
  restore(freshDump, freshDatabase);
  // 迁移账本必须含既有 0004 中文名称迁移与新增 0005 密文表；两者均不可在备份/恢复时静默丢失。
  assert.equal(sql(freshDatabase, "SELECT count(*) FROM schema_migrations").trim(), "5");
  assert.equal(sql(freshDatabase, "SELECT count(*) FROM admin_credentials").trim(), "0");
  assert.equal(sql(freshDatabase, "SELECT count(*) FROM price_snapshots").trim(), "0");
});

test("夹具备份原子完成、失败不覆盖旧档且保留最新两份", { timeout: 120_000 }, () => {
  seedSourceFixture();

  const first = backup();
  assertCustomArchive(first);
  // 同目录另一数据库的契约名归档是保留隔离的哨兵；它不是当前数据库的归档，任何 retention 均不得删除它。
  writeFileSync(otherDatabaseSentinel, "other-database-sentinel", { mode: 0o600 });
  const beforeFailure = readBackupNames();

  // bootstrap 创建普通 app 无权 LOCK/读取的表；pg_dump 会在已经写入 host 临时文件的阶段失败，
  // 因而本断言覆盖“部分归档清理”而非服务不可用时尚未开始的早期参数失败。
  bootstrapSql(sourceDatabase, "CREATE TABLE backup_denied (id integer primary key)");
  bootstrapSql(sourceDatabase, "INSERT INTO backup_denied (id) VALUES (1)");
  assert.throws(() => backup(), /备份失败|postgres|连接|exit/i);
  assert.deepEqual(readBackupNames(), beforeFailure, "失败备份不得覆盖或删除既有成功归档");
  assert.equal(readTemporaryFiles().length, 0, "pg_dump 失败后的部分临时归档必须被精确清理");
  bootstrapSql(sourceDatabase, "DROP TABLE backup_denied");

  const second = backup();
  const third = backup();
  assertCustomArchive(second);
  assertCustomArchive(third);
  const retained = readBackupNames();
  assert.equal(retained.length, 2, "保留策略只能留下配置的两个最新成功归档");
  assert.deepEqual(retained, [basename(second), basename(third)].sort(), "保留策略不得删除新归档或保留更旧归档");
  assert.equal(existsSync(otherDatabaseSentinel), true, "当前库的 retention 不得删除其他数据库归档");
  assert.equal(readTemporaryFiles().length, 0, "成功或失败后都不得留下可被误认成最终备份的临时文件");
});

test("超大保留数、已占用锁和被 touch 的旧归档都不破坏成功序列", { timeout: 120_000 }, () => {
  const before = readBackupNames();
  // 超出 1..10000 的十进制值必须在 mktemp 或 Docker 前拒绝，已有成功归档字节与数量都不变。
  assert.throws(() => backup("18446744073709551616"), /保留份数/);
  assert.deepEqual(readBackupNames(), before);
  const lock = resolve(backupDirectory, `.switch-price-monitor-backup-${sourceFileSegment}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  assert.throws(() => backup(), /锁|备份/);
  assert.deepEqual(readBackupNames(), before);
  assert.equal(readTemporaryFiles().length, 0);
  // 锁是本测试刚创建的空目录；非递归 rmdir 保证不会扩大删除范围。
  rmdirSync(lock);
  // 修改旧档 mtime 不能让它冒充最新成功备份；最终 18 位 sequence 才是唯一保留顺序。
  const touchedOldArchive = resolve(backupDirectory, before[0]);
  // before 只保存受控 basename；重新解析后必须仍在 canonical BACKUP_DIR，才能证明 touch 修改的是旧成功归档而非仓库 cwd 文件。
  assert.equal(resolve(realpathSync(touchedOldArchive), ".."), realpathSync(backupDirectory));
  execFileSync("touch", [touchedOldArchive]);
  const next = backup();
  assert.match(basename(next), new RegExp(`^switch-price-monitor-${sourceFileSegment}-\\d{18}-\\d{8}T\\d{6}Z\\.dump$`));
  const retained = readBackupNames();
  assert.deepEqual(retained, [before.at(-1), basename(next)].sort(), "touch 的旧归档不得挤掉较新成功档");
  // 受控复制有效 archive 并赋予 18 位前导零 sequence=8；下一次必须产生 9，保留只能剩 8/9，不能把字符串当八进制算术。
  const sequenceEight = resolve(backupDirectory, "switch-price-monitor-task9_source-000000000000000008-20260729T000000Z.dump");
  copyFileSync(next, sequenceEight);
  const sequenceNine = backup();
  assert.deepEqual(readBackupNames(), [basename(sequenceEight), basename(sequenceNine)].sort(), "前导零 sequence 的 retention 必须精确保留 8 和 9");
});

test("运行中的 app 与非空目标都会拒绝恢复", { timeout: 120_000 }, () => {
  const dump = newestBackup();
  createEmptyDatabase(freshDatabase);
  compose(["up", "-d", appService]);
  assert.throws(() => restore(dump, freshDatabase), /app.*运行|运行.*app|拒绝/i);
  compose(["stop", appService]);

  // 空库防线在任何 pg_restore 前执行；这里的哨兵表证明脚本不会以 --clean 或覆盖方式破坏已有目标内容。
  sql(freshDatabase, "CREATE TABLE restore_guard (id integer primary key)");
  assert.throws(() => restore(dump, freshDatabase), /非空|应用表|对象|所有者|拒绝/i);
  assert.equal(sql(freshDatabase, "SELECT count(*) FROM restore_guard").trim(), "0");
});

test("带应用夹具的恢复保留迁移、认证与价格历史", { timeout: 120_000 }, () => {
  const dump = newestBackup();
  createEmptyDatabase(fixtureDatabase);
  restore(dump, fixtureDatabase);
  assertRestoredFixture(fixtureDatabase);
  assert.equal(countRestoreTemporaryArchives(), 0, "成功恢复后 postgres 容器不得留下 Task 9 archive");
});

test("账本 checksum 与迁移精确字节不一致的 archive 必须拒绝恢复", { timeout: 120_000 }, () => {
  // 临时改为固定 64 个零仅构造坏归档；备份后立即还原真实 SHA，后续测试不继承错误源库状态。
  sql(sourceDatabase, "UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = '0001_initial.sql'");
  const badDump = backup("4");
  sql(sourceDatabase, `UPDATE schema_migrations SET checksum = '${migrationChecksum("0001_initial.sql")}' WHERE version = '0001_initial.sql'`);
  // 共享表空间授权位于目标数据库之外；恢复失败清理绝不能用 DROP OWNED 顺带撤销该授权。
  bootstrapSharedPrivilege("GRANT CREATE ON TABLESPACE pg_default TO task9_app");
  assert.equal(explicitTablespaceGrantCount(sourceDatabase), 1);
  createEmptyDatabase(checksumFailureDatabase);
  assert.throws(() => restore(badDump, checksumFailureDatabase), /迁移|校验/);
  assert.equal(countUserObjects(checksumFailureDatabase), 0, "checksum 校验失败必须把本次恢复产生的全部用户对象清回空库");
  assert.equal(explicitTablespaceGrantCount(checksumFailureDatabase), 1, "目标库清理不得撤销共享表空间显式授权");
  bootstrapSharedPrivilege("REVOKE CREATE ON TABLESPACE pg_default FROM task9_app");
  const retryDump = backup("6");
  restore(retryDump, checksumFailureDatabase);
  assertRestoredFixture(checksumFailureDatabase);
});

test("含第二条管理员认证材料的 archive 必须拒绝恢复", { timeout: 120_000 }, () => {
  // 合成值只验证单管理员 id=1 约束，既不派生真实密码/恢复码，也不会进入测试输出或文档。
  invalidAdminFixtureSql("ALTER TABLE admin_credentials DROP CONSTRAINT admin_credentials_id_check");
  invalidAdminFixtureSql("INSERT INTO admin_credentials (id, password_hash, password_salt, recovery_hash, recovery_salt, created_at) VALUES (2, 'synthetic-hash-2', 'synthetic-salt-2', 'synthetic-recovery-hash-2', 'synthetic-recovery-salt-2', now())");
  const invalidAdminDump = backup("5");
  invalidAdminFixtureSql("DELETE FROM admin_credentials WHERE id = 2");
  invalidAdminFixtureSql("ALTER TABLE admin_credentials ADD CONSTRAINT admin_credentials_id_check CHECK (id = 1)");
  createEmptyDatabase(adminFailureDatabase);
  assert.throws(() => restore(invalidAdminDump, adminFailureDatabase), /认证|管理员/);
  assert.equal(countUserObjects(adminFailureDatabase), 0, "管理员校验失败必须把坏认证数据与全部用户对象清回空库");
  const retryDump = backup("7");
  restore(retryDump, adminFailureDatabase);
  assertRestoredFixture(adminFailureDatabase);
});

test("缺失核心表的 archive 必须拒绝并把目标恢复为空库", { timeout: 120_000 }, () => {
  // 只临时改名核心表来构造“迁移账本正确但应用结构不完整”的真实 custom archive；备份后立即恢复源库表名。
  sql(sourceDatabase, "ALTER TABLE price_snapshots RENAME TO price_snapshots_missing");
  const missingCoreDump = backup("8");
  sql(sourceDatabase, "ALTER TABLE price_snapshots_missing RENAME TO price_snapshots");
  createEmptyDatabase(coreTableFailureDatabase);
  assert.throws(() => restore(missingCoreDump, coreTableFailureDatabase), /迁移|核心表|校验/);
  assert.equal(countUserObjects(coreTableFailureDatabase), 0, "核心表校验失败必须清理已提交的恢复对象");
  const retryDump = backup("9");
  restore(retryDump, coreTableFailureDatabase);
  assertRestoredFixture(coreTableFailureDatabase);
});

test("缺失任一非代表性必需表的 archive 也必须拒绝并清回空库", { timeout: 120_000 }, () => {
  // sessions 不属于旧五表抽样，但它是认证可启动性的必需表；迁移账本仍正确时，恢复必须按完整精确表集合拒绝该归档。
  sql(sourceDatabase, "ALTER TABLE sessions RENAME TO sessions_missing");
  const missingRequiredTableDump = backup("10");
  sql(sourceDatabase, "ALTER TABLE sessions_missing RENAME TO sessions");
  createEmptyDatabase(requiredTableFailureDatabase);
  assert.throws(() => restore(missingRequiredTableDump, requiredTableFailureDatabase), /迁移|完整|表|校验/);
  assert.equal(countUserObjects(requiredTableFailureDatabase), 0, "任一必需表缺失都必须把目标清回可重试空库");
  const retryDump = backup("11");
  restore(retryDump, requiredTableFailureDatabase);
  assertRestoredFixture(requiredTableFailureDatabase);
});

test("缺失 AI 密文配置表的 archive 必须拒绝并清回空库", { timeout: 120_000 }, () => {
  // ai_provider_configuration 保存 AES-GCM 密文而非可选 UI 草稿；迁移账本即使仍含 0005，缺表也会让重启后的设置读取失去持久化合同。
  sql(sourceDatabase, "ALTER TABLE ai_provider_configuration RENAME TO ai_provider_configuration_missing");
  const missingAiConfigurationDump = backup("12");
  sql(sourceDatabase, "ALTER TABLE ai_provider_configuration_missing RENAME TO ai_provider_configuration");
  createEmptyDatabase(requiredTableFailureDatabase);
  assert.throws(() => restore(missingAiConfigurationDump, requiredTableFailureDatabase), /迁移|完整|表|校验/);
  assert.equal(countUserObjects(requiredTableFailureDatabase), 0, "缺失 AI 密文表的 archive 也必须清回可重试空库");
});

test("缺失已确认中文名称词条表的 archive 必须拒绝并清回空库", { timeout: 120_000 }, () => {
  // game_name_catalog 是不可变 0004 迁移创建的已确认名称审计表；即使本任务只新增 0005，恢复守卫也必须保护完整历史迁移合同。
  sql(sourceDatabase, "ALTER TABLE game_name_catalog RENAME TO game_name_catalog_missing");
  const missingGameNameCatalogDump = backup("15");
  sql(sourceDatabase, "ALTER TABLE game_name_catalog_missing RENAME TO game_name_catalog");
  createEmptyDatabase(requiredTableFailureDatabase);
  assert.throws(() => restore(missingGameNameCatalogDump, requiredTableFailureDatabase), /迁移|完整|表|校验/);
  assert.equal(countUserObjects(requiredTableFailureDatabase), 0, "缺失 0004 名称词条表的 archive 也必须清回可重试空库");
});

test("含未声明 public 表的 archive 必须拒绝并清回空库", { timeout: 120_000 }, () => {
  // 未知表可能来自未受审计的手工写入或错误版本；精确集合守卫不能只验证必需表都在，否则会把不受当前迁移约束的数据带入目标库。
  sql(sourceDatabase, "CREATE TABLE unexpected_restore_table (id integer primary key)");
  const unexpectedTableDump = backup("16");
  sql(sourceDatabase, "DROP TABLE unexpected_restore_table");
  createEmptyDatabase(requiredTableFailureDatabase);
  assert.throws(() => restore(unexpectedTableDump, requiredTableFailureDatabase), /迁移|完整|表|校验/);
  assert.equal(countUserObjects(requiredTableFailureDatabase), 0, "含未知 public 表的 archive 必须清回可重试空库");
  const retryDump = backup("17");
  restore(retryDump, requiredTableFailureDatabase);
  assertRestoredFixture(requiredTableFailureDatabase);
});

test("恢复拒绝 bootstrap 所有者、paused app 和仅 view 的目标", { timeout: 120_000 }, () => {
  const dump = newestBackup();
  createBootstrapOwnedDatabase(bootstrapOwnedDatabase);
  assert.throws(() => restore(dump, bootstrapOwnedDatabase), /所有者|拒绝/);
  createEmptyDatabase(viewOnlyDatabase);
  sql(viewOnlyDatabase, "CREATE VIEW restore_only_view AS SELECT 1 AS id");
  assert.throws(() => restore(dump, viewOnlyDatabase), /非空|对象|所有者|拒绝/);
  compose(["up", "-d", appService]);
  compose(["pause", appService]);
  assert.throws(() => restore(dump, fixtureDatabase), /app.*运行|运行.*app|拒绝/);
  compose(["unpause", appService]);
  compose(["stop", appService]);
});

test("恢复空库守卫拒绝普通角色创建的非关系数据库对象", { timeout: 120_000 }, () => {
  const dump = newestBackup();
  const catalogFixtures = [
    "CREATE COLLATION task9_restore_collation (provider = libc, locale = 'C')",
    "CREATE TEXT SEARCH CONFIGURATION task9_restore_search (COPY = pg_catalog.simple)",
    "CREATE PUBLICATION task9_restore_publication",
    "CREATE OPERATOR public.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = pg_catalog.int4eq)",
  ];
  for (const statement of catalogFixtures) {
    // 每类 catalog 对象都在新建空库中由普通 app owner 真实创建；重建数据库可证明每次拒绝来自当前对象而非上一个夹具残留。
    createEmptyDatabase(catalogGuardDatabase);
    sql(catalogGuardDatabase, statement);
    assert.throws(() => restore(dump, catalogGuardDatabase), /目标数据库所有者或用户对象不符合空库恢复要求/);
  }
});

test("目录可列但数据段截断的 archive 恢复失败仍保持空目标和零容器临时文件", { timeout: 120_000 }, () => {
  const source = newestBackup();
  const truncated = resolve(backupDirectory, "switch-price-monitor-task9_source-999999999999999999-20260729T000000Z.dump");
  copyFileSync(source, truncated);
  // 保留 archive 目录尾部使 pg_restore --list 可读取目录，同时截断数据段以触发实际 restore 的失败路径。
  truncateSync(truncated, Math.max(1, statSync(truncated).size - 128));
  assertCustomArchive(truncated);
  createEmptyDatabase(failedRestoreDatabase);
  assert.throws(() => restore(truncated, failedRestoreDatabase), /恢复失败/);
  assert.equal(countUserObjects(failedRestoreDatabase), 0);
  assert.equal(countRestoreTemporaryArchives(), 0);
});

test.after(() => {
  // 禁止宽泛清理：Compose down 只使用本测试生成的 project 名，宿主目录也精确指向 mkdtemp 返回值。
  spawnSync("docker", ["compose", "--env-file", envFile, "-f", composeFile, "-p", projectName, "down", "--volumes", "--remove-orphans"], { stdio: "ignore" });
  rmSync(taskRoot, { recursive: true, force: true });
});

/** 写入只供本测试使用的 Compose；app 是无网络/无端口的休眠容器，用于验证恢复时运行 app 的拒绝边界。 */
function writeFixtureCompose() {
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  const initScript = resolve(repositoryRoot, "docker/postgres/init-app-role.sh");
  const migrationDirectory = resolve(repositoryRoot, "migrations/postgres");
  // Compose 故意只引用 env 插值且测试从项目目录外启动，证明运维脚本不能依赖 cwd 自动发现 `.env`。
  writeFileSync(envFile, `TASK9_DATABASE=${sourceDatabase}\nTASK9_BOOTSTRAP_USER=task9_bootstrap\nTASK9_BOOTSTRAP_PASSWORD=synthetic-bootstrap-only\nTASK9_APP_USER=task9_app\nTASK9_APP_PASSWORD=synthetic-app-only\n`, { mode: 0o600 });
  writeFileSync(composeFile, `services:\n  ${databaseService}:\n    image: postgres:17\n    environment:\n      POSTGRES_DB: \${TASK9_DATABASE:?TASK9_DATABASE_REQUIRED}\n      POSTGRES_USER: \${TASK9_BOOTSTRAP_USER:?TASK9_BOOTSTRAP_USER_REQUIRED}\n      POSTGRES_PASSWORD: \${TASK9_BOOTSTRAP_PASSWORD:?TASK9_BOOTSTRAP_PASSWORD_REQUIRED}\n      APP_DATABASE_USER: \${TASK9_APP_USER:?TASK9_APP_USER_REQUIRED}\n      APP_DATABASE_PASSWORD: \${TASK9_APP_PASSWORD:?TASK9_APP_PASSWORD_REQUIRED}\n    volumes:\n      - type: bind\n        source: ${initScript}\n        target: /docker-entrypoint-initdb.d/010-init-app-role.sh\n        read_only: true\n      - type: bind\n        source: ${migrationDirectory}\n        target: /fixtures\n        read_only: true\n  app:\n    image: postgres:17\n    command: [\"sh\", \"-ceu\", \"sleep infinity\"]\n    volumes:\n      - type: bind\n        source: ${migrationDirectory}\n        target: /app/migrations/postgres\n        read_only: true\n`);
}

/** 所有 Docker 调用都明确 Compose 文件与 project，避免 Docker 默认项目名意外选择现有开发或验收容器。 */
function compose(argumentsList, options = {}) {
  // 归档校验必须把受控 custom dump 的 Buffer 真实送进容器 stdin；其余 Compose 命令继续忽略 stdin，
  // 防止测试进程意外继承终端输入或秘密。不能固定 ignore，否则 pg_restore 只能读取空归档而伪造恢复失败。
  const acceptsInput = Object.prototype.hasOwnProperty.call(options, "input");
  return execFileSync("docker", ["compose", "--env-file", envFile, "-f", composeFile, "-p", projectName, ...argumentsList], {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
    stdio: [acceptsInput ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

/** 只启动本测试唯一 project 的数据库服务，并等待普通 app 角色可认证，不能误用 bootstrap 健康状态。 */
function startDatabase() {
  compose(["up", "-d", databaseService]);
  waitForDatabase();
}

/** 等待只探测本项目普通角色；不能借 bootstrap 角色把错误 init 伪装成可恢复的应用数据库。 */
function waitForDatabase() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = spawnSync("docker", ["compose", "--env-file", envFile, "-f", composeFile, "-p", projectName, "exec", "-T", databaseService, "sh", "-ceu", `PGPASSWORD=\"$APP_DATABASE_PASSWORD\" psql --host ${databaseService} --username \"$APP_DATABASE_USER\" --dbname \"$POSTGRES_DB\" --quiet --no-psqlrc --command 'SELECT 1'`], { encoding: "utf8" });
    if (probe.status === 0) return;
    execFileSync("sleep", ["1"]);
  }
  throw new Error("Task 9 临时 PostgreSQL 未在限定时间内就绪");
}

/** 使用普通角色执行容器内 SQL；测试字符串均为固定夹具，不接受外部输入或生产凭据。 */
function sql(database, statement) {
  return compose(["exec", "-T", databaseService, "sh", "-ceu", `PGPASSWORD=\"$APP_DATABASE_PASSWORD\" psql --host ${databaseService} --username \"$APP_DATABASE_USER\" --dbname ${database} --quiet --no-psqlrc --tuples-only --no-align --command ${JSON.stringify(statement)}`]);
}

/** bootstrap 仅为构造 app 无权访问的真实权限边界；它不被待测脚本调用，也不输出任何凭据。 */
function bootstrapSql(database, statement) {
  assert.equal(database, sourceDatabase);
  assert.ok([
    "CREATE TABLE backup_denied (id integer primary key)",
    "INSERT INTO backup_denied (id) VALUES (1)",
    "DROP TABLE backup_denied",
  ].includes(statement), "bootstrap SQL 必须是本测试预先枚举的权限夹具语句");
  return compose(["exec", "-T", databaseService, "sh", "-ceu", `psql --username \"$POSTGRES_USER\" --dbname ${sourceDatabase} --quiet --no-psqlrc --command ${JSON.stringify(statement)}`]);
}

/**
 * bootstrap 只在本测试唯一 PostgreSQL 容器内授予或撤销一项固定共享表空间权限，用作跨数据库破坏哨兵；
 * 待测脚本永远拿不到 bootstrap 凭据，且辅助函数不接受任意角色、表空间或 SQL。
 */
function bootstrapSharedPrivilege(statement) {
  assert.ok([
    "GRANT CREATE ON TABLESPACE pg_default TO task9_app",
    "REVOKE CREATE ON TABLESPACE pg_default FROM task9_app",
  ].includes(statement), "共享权限夹具 SQL 必须来自固定白名单");
  return compose(["exec", "-T", databaseService, "sh", "-ceu", `psql --username "$POSTGRES_USER" --dbname postgres --quiet --no-psqlrc --command ${JSON.stringify(statement)}`]);
}

/** 只统计 app 角色在共享 pg_default 上自己的 CREATE ACL；不能用会混入 PUBLIC 权限的 has_tablespace_privilege 伪造哨兵。 */
function explicitTablespaceGrantCount(database) {
  return Number(sql(database, "SELECT count(*) FROM pg_tablespace t CROSS JOIN LATERAL aclexplode(t.spcacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE t.spcname='pg_default' AND r.rolname=current_user AND a.privilege_type='CREATE'").trim());
}

/** 仅允许三条预枚举夹具 SQL：暂移源库 CHECK 形成坏 archive 后立即删除 id2 并恢复约束，不能接受外部 SQL 或秘密。 */
function invalidAdminFixtureSql(statement) {
  assert.ok([
    "ALTER TABLE admin_credentials DROP CONSTRAINT admin_credentials_id_check",
    "INSERT INTO admin_credentials (id, password_hash, password_salt, recovery_hash, recovery_salt, created_at) VALUES (2, 'synthetic-hash-2', 'synthetic-salt-2', 'synthetic-recovery-hash-2', 'synthetic-recovery-salt-2', now())",
    "DELETE FROM admin_credentials WHERE id = 2",
    "ALTER TABLE admin_credentials ADD CONSTRAINT admin_credentials_id_check CHECK (id = 1)",
  ].includes(statement), "非法管理员夹具 SQL 必须来自固定白名单");
  return sql(sourceDatabase, statement);
}

/** 使用当前完整迁移集建立 source 基线，账本 checksum 来自精确字节，供恢复 manifest 对照。 */
function createMigratedSchema() {
  sql(sourceDatabase, "CREATE TABLE schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default current_timestamp)");
  sql(sourceDatabase, "\\i /fixtures/0001_initial.sql");
  sql(sourceDatabase, "\\i /fixtures/0002_remove_target_price.sql");
  sql(sourceDatabase, "\\i /fixtures/0003_proxy_settings.sql");
  sql(sourceDatabase, "\\i /fixtures/0004_simplified_chinese_game_names.sql");
  sql(sourceDatabase, "\\i /fixtures/0005_ai_provider_configuration.sql");
  sql(sourceDatabase, `INSERT INTO schema_migrations (version, checksum) VALUES ('0001_initial.sql', '${migrationChecksum("0001_initial.sql")}'), ('0002_remove_target_price.sql', '${migrationChecksum("0002_remove_target_price.sql")}'), ('0003_proxy_settings.sql', '${migrationChecksum("0003_proxy_settings.sql")}'), ('0004_simplified_chinese_game_names.sql', '${migrationChecksum("0004_simplified_chinese_game_names.sql")}'), ('0005_ai_provider_configuration.sql', '${migrationChecksum("0005_ai_provider_configuration.sql")}')`);
}

/** 账本校验和必须来自迁移精确字节；不能用夹具常量掩盖未来 app manifest 与恢复记录的不一致。 */
function migrationChecksum(version) { return createHash("sha256").update(readFileSync(resolve(repositoryRoot, "migrations/postgres", version))).digest("hex"); }

/** 仅向已迁移 source 追加固定认证/价格夹具，验证 archive 保存业务历史而不接收外部秘密。 */
function seedSourceFixture() {
  // 此函数只在已完成 migration-only 备份/恢复后追加固定业务夹具，使第二份归档确实含认证和价格历史。
  sql(sourceDatabase, "INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at) VALUES (1, '[\"JP\"]', 'JP', now(), now())");
  sql(sourceDatabase, "INSERT INTO admin_credentials (id, password_hash, password_salt, recovery_hash, recovery_salt, created_at) VALUES (1, 'fixture-password-hash', 'fixture-password-salt', 'fixture-recovery-hash', 'fixture-recovery-salt', now())");
  sql(sourceDatabase, "INSERT INTO games (id, name_zh, name_en, product_type) VALUES ('fixture-game', '备份夹具游戏', 'Backup Fixture Game', 'game')");
  sql(sourceDatabase, "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ('fixture-product', 'fixture-game', 'JP', 'JPY', 'https://example.test/task9', 'manual-link')");
  sql(sourceDatabase, "INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ('fixture-product', 5980, 'JPY', 28000, 'official', '2026-07-29T00:00:00.000Z')");
}

/** 所有备份目标均来自本测试固定常量；retention 参数仅用于边界断言，禁止测试默认 Docker project。 */
function backup(retention = "2") {
  return runBackupScript(["--compose-file", composeFile, "--env-file", envFile, "--project-name", projectName, "--database-service", databaseService, "--database", sourceDatabase, "--project-root", projectRoot, "--backup-dir", backupDirectory, "--retention", retention]);
}

/** 恢复只向白名单目标库发送 BACKUP_DIR 内的受控 dump，避免辅助函数扩大删除或覆盖范围。 */
function restore(dump, database) {
  return runRestoreScript(["--compose-file", composeFile, "--env-file", envFile, "--project-name", projectName, "--app-service", appService, "--database-service", databaseService, "--project-root", projectRoot, "--backup-dir", backupDirectory, "--dump", dump, "--database", database]);
}

/** 共用执行器捕获输出且拒绝合成密码；调用方再按备份/恢复各自公开 stdout 合同断言。 */
function runScript(script, argumentsList) {
  // 从 Compose/项目目录外启动，模拟 DSM 计划任务的任意工作目录；成功只能来自显式绝对 env 文件，不能依赖 cwd 自动发现。
  const result = spawnSync(script, argumentsList, { cwd: taskRoot, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.doesNotMatch(output, /synthetic-(?:bootstrap|app)-only/, "脚本输出不得泄露容器密码");
  if (result.status !== 0) throw new Error(output || `脚本退出码 ${result.status}`);
  return result.stdout.trim();
}

/** 备份成功只能公开新归档路径，避免测试把 restore 固定成功消息误判为文件名。 */
function runBackupScript(argumentsList) { const output = runScript(backupScript, argumentsList); /* macOS /var 是 /private/var 别名，脚本 canonicalize 后输出真实路径，测试必须比较同一安全边界。 */ const canonicalBackupDirectory = realpathSync(backupDirectory); assert.match(output, new RegExp(`^${canonicalBackupDirectory.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}/switch-price-monitor-${sourceFileSegment}-\\d{18}-\\d{8}T\\d{6}Z\\.dump$`)); return output; }
/** 恢复成功使用固定无秘密消息；与备份路径合同分离，防止两种操作互相掩盖回归。 */
function runRestoreScript(argumentsList) { const output = runScript(restoreScript, argumentsList); assert.equal(output, "恢复完成并通过迁移与完整表集合验证"); return output; }

/** 在 postgres:17 容器内真实列 archive，验证 18 位 sequence 命名和 custom 格式，不暴露 archive 内容。 */
function assertCustomArchive(dump) {
  assert.match(basename(dump), new RegExp(`^switch-price-monitor-${sourceFileSegment}-\\d{18}-\\d{8}T\\d{6}Z\\.dump$`));
  assert.ok(readFileSync(dump).byteLength > 0, "成功归档不得为空");
  compose(["exec", "-T", databaseService, "sh", "-ceu", "archive=$(mktemp /tmp/task9-archive.XXXXXX); trap 'rm -f -- \"$archive\"' EXIT; cat > \"$archive\"; pg_restore --list \"$archive\" >/dev/null", "sh"], { input: readFileSync(dump) });
}

/** bootstrap 仅创建白名单空库并交给普通 app owner；待测恢复脚本从不使用 bootstrap。 */
function createEmptyDatabase(database) {
  assert.match(database, /^(?:task9_fresh|task9_fixture|task9_view_only|task9_restore_failure|task9_checksum_failure|task9_admin_failure|task9_core_failure|task9_required_table_failure|task9_catalog_guard)$/);
  compose(["exec", "-T", databaseService, "sh", "-ceu", `psql --username \"$POSTGRES_USER\" --dbname postgres --quiet --no-psqlrc --command \"DROP DATABASE IF EXISTS ${database}\"; psql --username \"$POSTGRES_USER\" --dbname postgres --quiet --no-psqlrc --command \"CREATE DATABASE ${database} OWNER $APP_DATABASE_USER\"`]);
}

/** bootstrap 所有者夹具只验证 restore 不越权；目标名白名单避免测试辅助 SQL 接受外部数据库标识。 */
function createBootstrapOwnedDatabase(database) {
  assert.equal(database, bootstrapOwnedDatabase);
  compose(["exec", "-T", databaseService, "sh", "-ceu", `psql --username \"$POSTGRES_USER\" --dbname postgres --quiet --no-psqlrc --command \"DROP DATABASE IF EXISTS ${database}\"; psql --username \"$POSTGRES_USER\" --dbname postgres --quiet --no-psqlrc --command \"CREATE DATABASE ${database} OWNER $POSTGRES_USER\"`]);
}

/** 容器内 find 只读取 Task 9 固定前缀，证明 restore trap 不会泄漏 archive；不读取其他 /tmp 数据。 */
function countRestoreTemporaryArchives() { const output = compose(["exec", "-T", databaseService, "sh", "-ceu", "find /tmp -maxdepth 1 -type f -name 'switch-price-monitor-restore.*' -print | wc -l"]).trim(); assert.match(output, /^\d+$/); return Number(output); }
/**
 * 以生产守卫同一 catalog 集合统计可由普通角色恢复的用户对象；这里只返回总数、不读取业务数据，
 * 且数据库白名单阻止测试辅助函数查询 Task 2/8 或其他现有项目。
 */
function countUserObjects(database) {
  assert.match(database, /^(?:task9_restore_failure|task9_checksum_failure|task9_admin_failure|task9_core_failure|task9_required_table_failure)$/);
  const catalogQuery = `WITH user_namespaces AS (
    SELECT oid,nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
  ), objects AS (
    SELECT nspname::text FROM user_namespaces WHERE nspname <> 'public'
    UNION ALL SELECT c.relname::text FROM pg_class c JOIN user_namespaces n ON n.oid=c.relnamespace
    UNION ALL SELECT p.proname::text FROM pg_proc p JOIN user_namespaces n ON n.oid=p.pronamespace
    UNION ALL SELECT t.typname::text FROM pg_type t JOIN user_namespaces n ON n.oid=t.typnamespace
    UNION ALL SELECT c.collname::text FROM pg_collation c JOIN user_namespaces n ON n.oid=c.collnamespace
    UNION ALL SELECT c.cfgname::text FROM pg_ts_config c JOIN user_namespaces n ON n.oid=c.cfgnamespace
    UNION ALL SELECT d.dictname::text FROM pg_ts_dict d JOIN user_namespaces n ON n.oid=d.dictnamespace
    UNION ALL SELECT p.prsname::text FROM pg_ts_parser p JOIN user_namespaces n ON n.oid=p.prsnamespace
    UNION ALL SELECT t.tmplname::text FROM pg_ts_template t JOIN user_namespaces n ON n.oid=t.tmplnamespace
    UNION ALL SELECT o.oprname::text FROM pg_operator o JOIN user_namespaces n ON n.oid=o.oprnamespace
    UNION ALL SELECT o.opcname::text FROM pg_opclass o JOIN user_namespaces n ON n.oid=o.opcnamespace
    UNION ALL SELECT o.opfname::text FROM pg_opfamily o JOIN user_namespaces n ON n.oid=o.opfnamespace
    UNION ALL SELECT c.conname::text FROM pg_conversion c JOIN user_namespaces n ON n.oid=c.connamespace
    UNION ALL SELECT pubname::text FROM pg_publication
    UNION ALL SELECT oid::text FROM pg_largeobject_metadata
    UNION ALL SELECT extname::text FROM pg_extension WHERE extname <> 'plpgsql'
    UNION ALL SELECT defaclobjtype::text FROM pg_default_acl
    UNION ALL SELECT fdwname::text FROM pg_foreign_data_wrapper
    UNION ALL SELECT srvname::text FROM pg_foreign_server
    UNION ALL SELECT evtname::text FROM pg_event_trigger
    UNION ALL SELECT subname::text FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database())
    UNION ALL SELECT lanname::text FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql')
  ) SELECT count(*) FROM objects`;
  // sql() 的 shell 边界不解释反斜线转义；压平固定空白可避免多行 JSON 字符串把 `\n` 当作 SQL 字面字符。
  return Number(sql(database, catalogQuery.replace(/\s+/g, " ")).trim());
}

/** 只读取迁移、管理员与代表性价格字段，证明恢复完整性且不读取认证材料。 */
function assertRestoredFixture(database) {
  // 恢复清单按完整文件名字典序对照，确保既有名称迁移与新增密文迁移都保留精确 checksum 账本。
  assert.equal(sql(database, "SELECT version FROM schema_migrations ORDER BY version").trim(), "0001_initial.sql\n0002_remove_target_price.sql\n0003_proxy_settings.sql\n0004_simplified_chinese_game_names.sql\n0005_ai_provider_configuration.sql");
  assert.equal(sql(database, "SELECT count(*) FROM admin_credentials WHERE id = 1").trim(), "1");
  assert.equal(sql(database, "SELECT amount_minor || ':' || cny_fen || ':' || source FROM price_snapshots").trim(), "5980:28000:official");
  assert.equal(sql(database, "SELECT count(*) FROM settings WHERE id = 1").trim(), "1");
}

/** 只返回当前固定 source 数据库的 basename，跨库 sentinel 不得影响 retention 断言。 */
function readBackupNames() { return readBackupPaths().map((path) => basename(path)); }
/** find 被限制在 canonical BACKUP_DIR 一层与固定命名空间，测试不扫描仓库或 NAS 的其他文件。 */
function readBackupPaths() { return execFileSync("find", [backupDirectory, "-maxdepth", "1", "-type", "f", "-name", `switch-price-monitor-${sourceFileSegment}-*.dump`, "-print"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort(); }
/** 两种临时文件都可能承载未验证归档或子命令 stderr；成功和失败路径均不得在 BACKUP_DIR 留下它们。 */
function readTemporaryFiles() { return execFileSync("find", [backupDirectory, "-maxdepth", "1", "-type", "f", "(", "-name", ".switch-price-monitor-backup.*", "-o", "-name", ".switch-price-monitor-backup-error.*", ")", "-print"], { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
/** 取得当前命名空间最新路径；为空立即失败，防止后续恢复误以为不存在的 archive 是有效输入。 */
function newestBackup() { const dumps = readBackupPaths(); assert.ok(dumps.length > 0, "测试需要至少一个成功归档"); return dumps.at(-1); }
