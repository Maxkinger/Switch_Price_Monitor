import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SettingsRepository } from "../src/repositories/postgres/settings-repository";
import { SubscriptionRepository } from "../src/repositories/postgres/subscription-repository";
import { runMigrations } from "../src/server/database/migrations";
import { SettingsValidationError } from "../src/services/settings-service";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("settings and subscriptions repositories", () => {
  // 两个仓储最终共享同一可丢弃 PostgreSQL；设置先完成 RED/GREEN，订阅读取按任务顺序稍后切换到 PostgreSQL 实现。
  const database = createTestDatabase();
  const settings = new SettingsRepository(database);
  const subscriptions = new SubscriptionRepository(database);

  beforeAll(async () => {
    // 每个 PostgreSQL 测试文件先重建专用 public schema 并运行正式迁移，绝不复用开发、NAS 或生产数据库中的既有状态。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 关闭测试池释放 TCP 连接，防止 Vitest 因悬挂 socket 无法退出或后续文件耗尽连接数。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 仅作用于已通过 disposable 双重校验的测试 schema；重置 identity 还保证并列时间排序用例的主键顺序可重复。
    await database.query("TRUNCATE settings, games, regional_products, subscriptions, subscription_regions RESTART IDENTITY CASCADE");
  });

  it("persists the enabled regions and default search region selected during initialization", async () => {
    // JSONB 参数显式写入数组，读取时必须原样恢复受控地区，并把 TIMESTAMPTZ 规范化为既有 ISO 字符串 DTO。
    await database.query(
      `INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at)
       VALUES (1, $1::jsonb, $2, $3, $3)`,
      [JSON.stringify(["US", "JP"]), "JP", "2026-07-16T00:00:00.000Z"],
    );

    await expect(settings.get()).resolves.toEqual({
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

  it("rejects JSONB settings that violate the existing region rules", async () => {
    // PostgreSQL 会成功解码任意合法 JSONB，但仓储仍必须复用服务层白名单，禁止未知地区通过数据库修复或手工写入进入商品发现流程。
    await database.query(
      `INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at)
       VALUES (1, $1::jsonb, $2, $3, $3)`,
      [JSON.stringify(["US", "EU"]), "US", "2026-07-16T00:00:00.000Z"],
    );

    await expect(settings.get()).rejects.toBeInstanceOf(SettingsValidationError);
  });

  it("rejects a valid JSONB object that is not the required region array", async () => {
    // JSONB 只保证语法合法；对象、字符串或 null 都不符合设置领域结构，必须统一映射为可控校验错误而不是 TypeError。
    await database.query(
      `INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at)
       VALUES (1, $1::jsonb, $2, $3, $3)`,
      [JSON.stringify({ US: true }), "US", "2026-07-16T00:00:00.000Z"],
    );

    await expect(settings.get()).rejects.toBeInstanceOf(SettingsValidationError);
  });

  it("reads one subscription with its selected regional products", async () => {
    // 先构造已验证地区商品和订阅关系，隔离本任务只迁移读取路径的范围，不提前实现 Task 4 的事务创建写入。
    await database.query(
      "INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)",
      ["game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game"],
    );
    await database.query(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)",
      ["us-overcooked-2", "game-overcooked-2", "US", "USD", "https://example.test/us", "manual-link"],
    );

    await database.query(
      "INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
      ["subscription-overcooked-2", "game-overcooked-2", true, "2026-07-16T00:00:00.000Z"],
    );
    await database.query(
      "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)",
      ["subscription-overcooked-2", "us-overcooked-2"],
    );

    await expect(subscriptions.findByGameId("game-overcooked-2")).resolves.toEqual({
      id: "subscription-overcooked-2",
      gameId: "game-overcooked-2",
      enabled: true,
      createdAt: "2026-07-16T00:00:00.000Z",
      regionalProductIds: ["us-overcooked-2"],
    });
  });

  it("maps PostgreSQL BOOLEAN and a nullable region aggregate without leaking database values", async () => {
    // 暂停且尚无地区关联的订阅仍需返回可恢复记录；空 LEFT JOIN 必须成为空数组，不能成为 `[null]` 或数据库聚合文本。
    await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["game-paused", "暂停游戏", "Paused Game", "game"]);
    await database.query(
      "INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
      ["subscription-paused", "game-paused", false, "2026-07-17T00:00:00.000Z"],
    );

    await expect(subscriptions.findByGameId("game-paused")).resolves.toEqual({
      id: "subscription-paused",
      gameId: "game-paused",
      enabled: false,
      createdAt: "2026-07-17T00:00:00.000Z",
      regionalProductIds: [],
    });
  });
});
