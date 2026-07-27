import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/database/types";
import { createTestDatabase, resetTestSchema, POSTGRES_MIGRATION_DIRECTORY } from "./support/postgres";
import { runMigrations } from "../src/server/database/migrations";
import { PostgresSettingsRepository } from "../src/repositories/postgres/settings-repository";

describe("PostgreSQL 设置读取仓储", () => {
  let database: AppDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    // 每例重建真实 PostgreSQL schema，确保 JSONB 异常夹具不会污染下一条设置读取断言。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
  });

  afterAll(async () => {
    await database.close();
  });

  it("以 JSONB 往返启用地区并把 TIMESTAMPTZ 规范化为 UTC ISO 字符串", async () => {
    // 夹具 SQL 只写固定一次性测试库并使用参数绑定；直接写入是为了隔离 Task 3 读取语义，不提前迁移 Task 4 初始化事务。
    await database.query(
      `INSERT INTO settings (
         id, enabled_regions_json, default_search_region, created_at, updated_at
       ) VALUES (1, $1::jsonb, $2, $3, $3)`,
      [JSON.stringify(["US", "JP"]), "JP", "2026-07-16T00:00:00.000Z"],
    );

    const repository = new PostgresSettingsRepository(database);
    await expect(repository.get()).resolves.toEqual({
      enabledRegions: ["US", "JP"],
      defaultSearchRegion: "JP",
      theme: "warm-card",
      timezone: "Asia/Shanghai",
      dailyReportTime: "09:00",
      taxState: "OR",
      priceHistoryRetention: "forever",
      createdAt: "2026-07-16T00:00:00.000Z",
    });
  });

  it("拒绝数据库中不符合现有地区白名单规则的 JSONB", async () => {
    // 数据库只保证 JSON 结构合法；仓储必须再次执行领域白名单校验，防止手工修复或旧版本写入未知地区后污染搜索范围。
    await database.query(
      `INSERT INTO settings (
         id, enabled_regions_json, default_search_region, created_at, updated_at
       ) VALUES (1, $1::jsonb, 'US', $2, $2)`,
      [JSON.stringify(["US", "XX"]), "2026-07-16T00:00:00.000Z"],
    );

    const repository = new PostgresSettingsRepository(database);
    await expect(repository.get()).rejects.toThrow("设置中的启用地区 JSONB 无效");
  });
});
