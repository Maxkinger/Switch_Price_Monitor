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

  it("returns only regional products selected by enabled subscriptions", async () => {
    // 停用订阅与停用地区商品都绝不能继续触发外部商店请求，避免无效采集、误通知和不必要的来源负载。
    // 日区价格 ID 是经商品确认流程写入的地区专属标识；读取遗漏会让后续官方价格接口错误退化为第三方来源。
    await database.query(
      "INSERT INTO games (id, name_zh, name_en, publisher, product_type) VALUES ($1, $2, $3, $4, $5)",
      ["game", "胡闹厨房 2", "Overcooked! 2", "Team17", "game"],
    );
    await database.query(
      `INSERT INTO regional_products (id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8), ($9, $2, $10, $11, NULL, $12, $7, $13)`,
      [
        "active-product", "game", "JP", "JPY", "70050000064985", "https://store-jp.nintendo.com/item/software/D70050000064985/", "manual_selection", true,
        "disabled-product", "US", "USD", "https://example.test/us", false,
      ],
    );
    await database.query(
      "INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
      ["active-subscription", "game", true, "2026-07-16T00:00:00.000Z"],
    );
    await database.query(
      "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2), ($1, $3)",
      ["active-subscription", "active-product", "disabled-product"],
    );

    await expect(new CollectionRepository(database).enabledRegionalProducts()).resolves.toEqual([expect.objectContaining({ id: "active-product", regionCode: "JP", currency: "JPY", officialPriceId: "70050000064985", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game" })]);
  });
});
