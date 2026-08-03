import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PriceRepository } from "../src/repositories/postgres/price-repository";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("PriceRepository", () => {
  // PostgreSQL 测试专门覆盖同一 TIMESTAMPTZ 下的 BIGINT identity 次序，保证最新官方价的选择可重复。
  const database = createTestDatabase();

  beforeAll(async () => {
    // 重建动作受固定 disposable URL 与 marker 双重保护，正式迁移随后提供真实 BIGINT/外键/索引定义。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 显式关闭连接池，避免价格测试结束后仍占用测试数据库连接。
    await database.close();
  });

  beforeEach(async () => {
    // 价格快照依赖地区商品；清空并重置 identity 后，同时间写入的后到记录会取得更大主键供排序断言使用。
    await database.query("TRUNCATE games, regional_products, price_snapshots RESTART IDENTITY CASCADE");
    await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["game-price", "价格测试游戏", "Price Test Game", "game"]);
    await database.query(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)",
      ["product-price", "game-price", "JP", "JPY", "https://example.test/jp", "manual-link"],
    );
  });

  it("returns the newest official snapshot while ignoring a later third-party fallback", async () => {
    // 降价规则只可比较官方连续快照；晚到的第三方数据虽然保留展示价值，但不得成为即时提醒的比较基线。
    await insertSnapshot(database, 1000, "official", "2026-07-16T00:00:00.000Z");
    await insertSnapshot(database, 900, "official", "2026-07-16T06:00:00.000Z");
    await insertSnapshot(database, 800, "nt-deals", "2026-07-16T12:00:00.000Z");

    await expect(new PriceRepository(database).latestOfficialFor("product-price")).resolves.toEqual({ amountMinor: 900, source: "official" });
  });

  it("uses the later identity when official snapshots share the same capture timestamp", async () => {
    // 同一轮并发或重试可能产生相同时间；后写入的官方事实必须以 id DESC 稳定成为比较基线。
    await insertSnapshot(database, 1000, "official", "2026-07-16T06:00:00.000Z");
    await insertSnapshot(database, 900, "official", "2026-07-16T06:00:00.000Z");

    await expect(new PriceRepository(database).latestOfficialFor("product-price")).resolves.toEqual({ amountMinor: 900, source: "official" });
  });
});

/** 价格夹具始终使用整数最小单位和参数绑定，来源字符串不会参与 SQL 结构。 */
async function insertSnapshot(database: ReturnType<typeof createTestDatabase>, amountMinor: number, source: string, capturedAt: string): Promise<void> {
  await database.query(
    "INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, source, captured_at) VALUES ($1, $2, $3, $4, $5)",
    ["product-price", amountMinor, "JPY", source, capturedAt],
  );
}
