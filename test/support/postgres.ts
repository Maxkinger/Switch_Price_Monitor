import process from "node:process";
import { fileURLToPath } from "node:url";
import { createPostgresDatabase } from "../../src/server/database/pool";
import { runMigrations } from "../../src/server/database/migrations";
import type { AppDatabase } from "../../src/server/database/types";

/**
 * 正式 PostgreSQL 迁移目录按模块位置解析，不依赖执行命令的当前目录，
 * 使本地 Vitest 与后续 CI 都读取受版本控制的同一组不可变 SQL 字节。
 */
export const POSTGRES_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../migrations/postgres", import.meta.url),
);

/**
 * 只接受 Task 2 Compose 暴露的回环测试库。严格校验主机、端口、账号和库名，
 * 是为了让 DROP SCHEMA 等破坏性测试辅助操作绝不落到开发常驻库、NAS 或生产数据库。
 */
export function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error("必须显式设置 TEST_DATABASE_URL 才能运行 PostgreSQL 集成测试");
  }

  const url = new URL(value);
  const isDisposableDatabase =
    url.protocol === "postgres:" &&
    url.hostname === "127.0.0.1" &&
    url.port === "54329" &&
    url.username === "switch_test" &&
    url.password === "switch_test" &&
    url.pathname === "/switch_test";
  if (!isDisposableDatabase) {
    throw new Error("TEST_DATABASE_URL 必须指向 Task 2 的一次性 switch_test 数据库");
  }
  return value;
}

/**
 * 重建一次性数据库的 public schema。调用方必须先经过 requireTestDatabaseUrl 的精确边界校验；
 * CASCADE 仅用于清除本任务测试创建的表、序列和约束，绝不能成为生产启动或普通业务 API。
 */
export async function resetTestSchema(database: AppDatabase): Promise<void> {
  await database.query("DROP SCHEMA public CASCADE");
  await database.query("CREATE SCHEMA public");
}

/**
 * 创建已迁移的独立测试连接池。每次调用先清空一次性 schema 再应用真实迁移，
 * 使后续仓储测试拥有确定基线；调用方负责 close，避免测试进程残留连接。
 */
export async function createTestDatabase(): Promise<AppDatabase> {
  const database = createPostgresDatabase(requireTestDatabaseUrl());
  try {
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
