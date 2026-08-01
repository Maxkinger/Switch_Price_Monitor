import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import type { AppDatabase } from "../src/server/database/types";
import { PostgresSubscriptionRepository } from "../src/repositories/postgres/subscription-repository";
import { PostgresSubscriptionDetailRepository } from "../src/repositories/postgres/subscription-detail-repository";
import { createTestDatabase, POSTGRES_MIGRATION_DIRECTORY, resetTestSchema } from "./support/postgres";

describe("PostgreSQL 订阅读取仓储", () => {
  let database: AppDatabase;
  beforeAll(async () => { database = await createTestDatabase(); });
  beforeEach(async () => {
    // 每例重建 schema 后构造一个已确认的双区游戏，其中仅一地区正在监控，用于验证 LEFT JOIN 空值边界。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
    await seedSubscription(database);
  });
  afterAll(async () => { await database.close(); });

  it("按游戏读取原生 BOOLEAN 和稳定地区 ID 数组", async () => {
    const repository = new PostgresSubscriptionRepository(database);
    await expect(repository.findByGameId("game-subscription")).resolves.toEqual({
      id: "subscription-read",
      gameId: "game-subscription",
      enabled: true,
      createdAt: "2026-07-16T00:00:00.000Z",
      regionalProductIds: ["product-jp"],
    });
    await expect(repository.gameIdForSubscription("subscription-read")).resolves.toBe("game-subscription");
    await expect(repository.hasEnabledProductsForGame("game-subscription", ["product-jp", "product-us"])).resolves.toBe(true);
    await expect(repository.hasEnabledProductsForGame("game-subscription", [])).resolves.toBe(false);
  });

  it("详情保留未监控地区和空快照并稳定选择同时间当前价与最低价", async () => {
    await database.query(
      `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at)
       VALUES ('product-jp', 900, 'JPY', 4200, 'official', $1),
              ('product-jp', 800, 'JPY', 3900, 'official', $1)`,
      ["2026-07-16T06:00:00.000Z"],
    );
    await database.query(
      `INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor)
       VALUES ('subscription-read', 'JP', 850)`,
    );

    const detail = await new PostgresSubscriptionDetailRepository(database).find("subscription-read");
    expect(detail).toMatchObject({
      subscriptionId: "subscription-read",
      enabled: true,
      globalTargetCnyFen: null,
      regionTargets: [{ regionCode: "JP", targetAmountMinor: 850 }],
    });
    expect(detail?.regions).toEqual([
      {
        regionalProductId: "product-jp",
        regionCode: "JP",
        currency: "JPY",
        monitored: true,
        current: { amountMinor: 800, cnyFen: 3900, source: "official", capturedAt: "2026-07-16T06:00:00.000Z" },
        historicalLow: { amountMinor: 800, cnyFen: 3900, source: "official", capturedAt: "2026-07-16T06:00:00.000Z" },
        isStale: false,
      },
      {
        regionalProductId: "product-us",
        regionCode: "US",
        currency: "USD",
        monitored: false,
        current: null,
        historicalLow: null,
        isStale: false,
      },
    ]);
  });

  it("不存在订阅返回 null 而不是泄漏数据库错误", async () => {
    await expect(new PostgresSubscriptionDetailRepository(database).find("missing")).resolves.toBeNull();
  });
});

async function seedSubscription(database: AppDatabase): Promise<void> {
  // 夹具使用参数化 SQL 建立读模型，刻意不调用 Task 4 才负责的订阅事务写仓储。
  await database.query(
    "INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)",
    ["game-subscription", "订阅读取", "Subscription Read", "game"],
  );
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at)
     VALUES ('product-jp', 'game-subscription', 'JP', 'JPY', 'https://example.test/jp', 'manual-link', $1),
            ('product-us', 'game-subscription', 'US', 'USD', 'https://example.test/us', 'manual-link', $2)`,
    ["2026-07-16T00:00:00.000Z", "2026-07-16T01:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
     VALUES ('subscription-read', 'game-subscription', TRUE, $1, $1)`,
    ["2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO subscription_regions (subscription_id, regional_product_id)
     VALUES ('subscription-read', 'product-jp')`,
  );
}
