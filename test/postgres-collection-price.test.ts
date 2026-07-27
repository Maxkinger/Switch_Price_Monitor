import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import { PostgresCollectionRepository } from "../src/repositories/postgres/collection-repository";
import { PostgresPriceRepository } from "../src/repositories/postgres/price-repository";
import { createTestDatabase, POSTGRES_MIGRATION_DIRECTORY, resetTestSchema } from "./support/postgres";

describe("PostgreSQL 采集商品与价格读取仓储", () => {
  let database: AppDatabase;
  beforeAll(async () => { database = await createTestDatabase(); });
  beforeEach(async () => {
    // 每例重建真实 schema，使 identity 并列顺序与原生 BOOLEAN 状态具有确定基线。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
    await seedCollection(database);
  });
  afterAll(async () => { await database.close(); });

  it("只返回启用订阅中的启用商品并保留可空官方价格 ID", async () => {
    await expect(new PostgresCollectionRepository(database).enabledRegionalProducts()).resolves.toEqual([
      {
        id: "product-active",
        regionCode: "JP",
        currency: "JPY",
        officialPriceId: null,
        productUrl: "https://example.test/jp",
        canonicalTitle: "Collection Test",
        publisher: null,
        productType: "game",
      },
    ]);
  });

  it("相同捕获时间按 identity 选择最后官方快照并按最早 identity 固定最低价", async () => {
    await database.query(
      `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at)
       VALUES ('product-active', 900, 'JPY', 4200, 'official', $1),
              ('product-active', 800, 'JPY', 3900, 'official', $1),
              ('product-active', 800, 'JPY', 3800, 'nt-deals', $1)`,
      ["2026-07-16T00:00:00.000Z"],
    );
    const repository = new PostgresPriceRepository(database);
    await expect(repository.latestOfficialFor("product-active")).resolves.toEqual({ amountMinor: 800, source: "official" });
    await expect(repository.lowestForRegionalProduct("product-active")).resolves.toEqual({
      regionalProductId: "product-active",
      amountMinor: 800,
      currency: "JPY",
      cnyFen: 3900,
      source: "official",
      capturedAt: "2026-07-16T00:00:00.000Z",
      regionCode: "JP",
    });
  });

  it("显式安全转换 pg BIGINT count 字符串并拒绝超过 JavaScript 安全整数的值", async () => {
    const repository = new PostgresPriceRepository(database);
    await expect(repository.countForRegionalProduct("product-active")).resolves.toBe(0);

    const unsafeExecutor: SqlExecutor = {
      // 该双桩只模拟 pg 对 BIGINT/COUNT 的字符串返回契约；超大值无法在轻量集成库中现实插入数千万亿行。
      async query<Row>() {
        return { rows: [{ count: "9007199254740992" }] as Row[], rowCount: 1 };
      },
    };
    await expect(new PostgresPriceRepository(unsafeExecutor).countForRegionalProduct("product-active")).rejects.toThrow("安全整数");
  });
});

async function seedCollection(database: AppDatabase): Promise<void> {
  // 参数化夹具构造启用/停用组合；不复用写服务，以免本组读测试提前覆盖 Task 4 事务迁移。
  await database.query(
    `INSERT INTO games (id, name_zh, name_en, product_type)
     VALUES ('game-active', '采集测试', 'Collection Test', 'game'),
            ('game-disabled', '停用测试', 'Disabled Test', 'game')`,
  );
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled)
     VALUES ('product-active', 'game-active', 'JP', 'JPY', NULL, 'https://example.test/jp', 'manual-link', TRUE),
            ('product-disabled', 'game-disabled', 'US', 'USD', 'price-id', 'https://example.test/us', 'manual-link', FALSE)`,
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
     VALUES ('subscription-active', 'game-active', TRUE, $1, $1),
            ('subscription-disabled', 'game-disabled', FALSE, $1, $1)`,
    ["2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO subscription_regions (subscription_id, regional_product_id)
     VALUES ('subscription-active', 'product-active'),
            ('subscription-disabled', 'product-disabled')`,
  );
}
