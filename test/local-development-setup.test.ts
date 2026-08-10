import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresSettingsRepository } from "../src/repositories/postgres/settings-repository";
import { ensureLocalDevelopmentSetup } from "../src/server/local-development-setup";
import type { AppDatabase } from "../src/server/database/types";
import { runMigrations } from "../src/server/database/migrations";
import {
  createTestDatabase,
  POSTGRES_MIGRATION_DIRECTORY,
  resetTestSchema,
} from "./support/postgres";

describe("本机开发启动设置", () => {
  let database: AppDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    // 每例从迁移完成但没有业务记录的 schema 开始，准确模拟首次本机启动而不复用其他测试的管理员或设置。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
  });

  afterAll(async () => {
    await database.close();
  });

  it("只在显式本机旁路开启时为搜索和设置页建立默认公开设置", async () => {
    // 关闭旁路不可写入任何首次设置，保证 NAS/生产仍展示正常初始化流程；开启后才允许空库获得免密码开发所需设置。
    await ensureLocalDevelopmentSetup(database, false, "2026-08-10T03:00:00.000Z");
    await expect(new PostgresSettingsRepository(database).get()).resolves.toBeNull();

    await ensureLocalDevelopmentSetup(database, true, "2026-08-10T03:00:00.000Z");
    await expect(new PostgresSettingsRepository(database).get()).resolves.toMatchObject({
      enabledRegions: ["US", "JP", "MX", "BR", "HK"],
      defaultSearchRegion: "US",
    });
  });
});
