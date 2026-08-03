import type { AppDatabase, SqlExecutor } from "../../src/server/database/types";
import { createPostgresDatabase } from "../../src/server/database/pool";

/** 该 marker 不是秘密，只用于要求调用者显式确认当前命令允许销毁专用测试 schema。 */
export const DISPOSABLE_TEST_DATABASE_MARKER = "switch-price-monitor-disposable-test";

/** 所有拒绝路径共享脱敏消息，防止误填的 NAS/生产 URL、用户名或密码进入测试与 CI 日志。 */
export const TEST_DATABASE_TARGET_ERROR = "PostgreSQL 集成测试目标未通过可丢弃数据库安全校验。";

/** 测试辅助层只读取两个安全相关变量，避免将完整 process.env 作为隐式权限来源传播给 destructive helper。 */
export interface DisposableTestDatabaseEnvironment {
  TEST_DATABASE_URL?: string;
  TEST_DATABASE_DISPOSABLE_MARKER?: string;
}

/**
 * 在创建任何客户端前验证可丢弃测试目标。
 * 校验同时要求固定回环主机、隔离端口、专用用户/数据库和显式 marker；任一条件不符都 fail closed，不能只凭名称包含 test 推断安全。
 */
export function validateDisposableTestDatabaseTarget(
  environment: Readonly<DisposableTestDatabaseEnvironment> = process.env,
): string {
  const connectionString = environment.TEST_DATABASE_URL;
  if (
    !connectionString
    || environment.TEST_DATABASE_DISPOSABLE_MARKER !== DISPOSABLE_TEST_DATABASE_MARKER
  ) {
    throw new Error(TEST_DATABASE_TARGET_ERROR);
  }

  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error(TEST_DATABASE_TARGET_ERROR);
  }

  const isDedicatedDisposableTarget = (
    (target.protocol === "postgres:" || target.protocol === "postgresql:")
    && target.hostname === "127.0.0.1"
    && target.port === "54329"
    && target.username === "switch_test"
    && target.password.length > 0
    && target.pathname === "/switch_test"
    // 禁止 query/hash，避免 pg 连接参数覆盖已检查的 host、port 或其他安全边界。
    && target.search === ""
    && target.hash === ""
  );
  if (!isDedicatedDisposableTarget) {
    throw new Error(TEST_DATABASE_TARGET_ERROR);
  }

  return connectionString;
}

/**
 * 只在目标通过完整 disposable 校验后创建 PostgreSQL 池。
 * 校验先于 pg 客户端构造，确保开发、NAS、生产样式或畸形 URL 不会建立连接，更不会进入后续 destructive setup。
 */
export function createTestDatabase(
  environment: Readonly<DisposableTestDatabaseEnvironment> = process.env,
): AppDatabase {
  const connectionString = validateDisposableTestDatabaseTarget(environment);
  return createPostgresDatabase(connectionString);
}

/**
 * 重建可丢弃 public schema，并在每次 DROP 前重复目标校验。
 * 即使未来测试绕过 createTestDatabase 或复用其他 executor，缺少专用目标与显式 marker 时也不会执行任何破坏性 SQL。
 */
export async function resetDisposableTestSchema(
  database: SqlExecutor,
  environment: Readonly<DisposableTestDatabaseEnvironment> = process.env,
): Promise<void> {
  validateDisposableTestDatabaseTarget(environment);
  await database.query("DROP SCHEMA public CASCADE");
  await database.query("CREATE SCHEMA public");
}
