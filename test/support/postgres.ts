import type { AppDatabase } from "../../src/server/database/types";
import { createPostgresDatabase } from "../../src/server/database/pool";

/**
 * 只允许测试通过显式 TEST_DATABASE_URL 创建 PostgreSQL 连接。
 * 缺少变量时立即失败，避免开发者误把默认地址指向开发库、NAS 库或含真实业务数据的实例。
 */
export function createTestDatabase(): AppDatabase {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("PostgreSQL 集成测试必须显式设置 TEST_DATABASE_URL，并指向可丢弃测试数据库。");
  }

  return createPostgresDatabase(connectionString);
}
