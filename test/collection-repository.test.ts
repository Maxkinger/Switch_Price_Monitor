import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CollectionRepository } from "../src/repositories/postgres/collection-repository";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("CollectionRepository", () => {
  // 真实 PostgreSQL 读取验证原生 BOOLEAN 与官方价格 ID 可空映射，避免继续依赖 SQLite 0/1 语义。
  const database = createTestDatabase();

  beforeAll(async () => {
    // 正式迁移定义启用状态、唯一地区关系和外键；测试必须从同一 schema 建立，不能使用宽松的临时表替代。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 释放本文件的 PostgreSQL 池，保证测试进程能及时退出并让下一文件独占重建 schema。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 仅清理经过 marker 验证的可丢弃 schema；采集范围由订阅和地区商品两层启用状态共同决定。
    await database.query("TRUNCATE games, regional_products, subscriptions, subscription_regions RESTART IDENTITY CASCADE");
  });

  it("returns only enabled regional products selected by enabled subscriptions, including a nullable official ID", async () => {
    // 订阅与地区商品的 BOOLEAN 必须分别过滤：任一层停用都不能继续触发外部商店请求；同时启用但尚无官方 ID 的商品仍须保留，供受控来源回退或后续人工确认处理。
    // 非空日区价格 ID 与可空美区价格 ID 同时断言，避免迁移时把 PostgreSQL NULL 误转为空字符串并让官方价格适配器使用伪造 ID。
    await database.query(
      `INSERT INTO games (id, name_zh, name_en, publisher, product_type)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [
        "game", "胡闹厨房 2", "Overcooked! 2", "Team17", "game",
        "disabled-subscription-game", "停用订阅游戏", "Disabled Subscription Game", "Team17", "game",
      ],
    );
    await database.query(
      `INSERT INTO regional_products (id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8),
              ($9, $2, $10, $11, NULL, $12, $7, $13),
              ($14, $2, $15, $16, $17, $18, $7, $19),
              ($20, $26, $21, $22, $23, $24, $7, $25)`,
      [
        "active-product", "game", "JP", "JPY", "70050000064985", "https://store-jp.nintendo.com/item/software/D70050000064985/", "manual_selection", true,
        "enabled-null-id-product", "US", "USD", "https://example.test/us", true,
        "disabled-product", "HK", "HKD", "70010000012345", "https://example.test/hk", false,
        "disabled-subscription-product", "EU", "EUR", "70010000054321", "https://example.test/eu", true,
        "disabled-subscription-game",
      ],
    );
    await database.query(
      `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4), ($5, $8, $6, $7, $7)`,
      ["active-subscription", "game", true, "2026-07-16T00:00:00.000Z", "disabled-subscription", false, "2026-07-16T01:00:00.000Z", "disabled-subscription-game"],
    );
    await database.query(
      `INSERT INTO subscription_regions (subscription_id, regional_product_id)
       VALUES ($1, $2), ($1, $3), ($1, $4), ($5, $6)`,
      ["active-subscription", "active-product", "enabled-null-id-product", "disabled-product", "disabled-subscription", "disabled-subscription-product"],
    );

    await expect(new CollectionRepository(database).enabledRegionalProducts()).resolves.toEqual([
      expect.objectContaining({ id: "active-product", regionCode: "JP", currency: "JPY", officialPriceId: "70050000064985", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game" }),
      expect.objectContaining({ id: "enabled-null-id-product", regionCode: "US", currency: "USD", officialPriceId: null, canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game" }),
    ]);
  });
});
