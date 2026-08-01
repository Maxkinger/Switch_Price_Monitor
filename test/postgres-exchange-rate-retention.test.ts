import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import type { AppDatabase } from "../src/server/database/types";
import { PostgresExchangeRateRepository } from "../src/repositories/postgres/exchange-rate-repository";
import { PostgresRetentionRepository } from "../src/repositories/postgres/retention-repository";
import { createTestDatabase, POSTGRES_MIGRATION_DIRECTORY, resetTestSchema } from "./support/postgres";

describe("PostgreSQL 汇率与保留仓储", () => {
  let database: AppDatabase;
  beforeAll(async () => { database = await createTestDatabase(); });
  beforeEach(async () => {
    // 每例重建一次性 schema，确保 identity 顺序和截止点计数不受其他仓储用例影响。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
  });
  afterAll(async () => { await database.close(); });

  it("同一捕获时刻按 BIGINT identity 稳定读取最后写入的汇率", async () => {
    // 先删除唯一约束是测试并列排序所需的受控结构变化，仅发生在一次性库；生产仍保留币种+时间去重约束。
    await database.query("ALTER TABLE exchange_rates DROP CONSTRAINT exchange_rates_currency_captured_at_key");
    await database.query(
      `INSERT INTO exchange_rates (currency, cny_rate, source, captured_at)
       VALUES ($1, $2, $3, $4), ($1, $5, $6, $4)`,
      ["USD", 7.1, "earlier-id", "2026-07-16T00:00:00.000Z", 7.2, "later-id"],
    );
    await expect(new PostgresExchangeRateRepository(database).latestFor("USD")).resolves.toEqual({
      currency: "USD",
      cnyRate: 7.2,
      source: "later-id",
      capturedAt: "2026-07-16T00:00:00.000Z",
    });
  });

  it("同一币种与捕获时刻的成功汇率重试保持幂等", async () => {
    const repository = new PostgresExchangeRateRepository(database);
    const capturedAt = "2026-07-18T00:00:00.000Z";

    // 两次写入模拟同一采集轮重试；唯一约束应保留首条可审计来源，不能覆盖或产生两条日报候选。
    await repository.append({ currency: "USD", cnyRate: 7.18, source: "first", capturedAt });
    await repository.append({ currency: "USD", cnyRate: 7.99, source: "retry", capturedAt });

    await expect(repository.latestFor("USD")).resolves.toEqual({
      currency: "USD",
      cnyRate: 7.18,
      source: "first",
      capturedAt,
    });
    const count = await database.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM exchange_rates WHERE currency = $1",
      ["USD"],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("只删除严格早于价格截止点的快照并返回安全数值计数", async () => {
    await seedProduct(database);
    await database.query(
      `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, source, captured_at)
       VALUES ('product-retention', 100, 'USD', 'official', $1),
              ('product-retention', 200, 'USD', 'official', $2)`,
      ["2026-07-15T23:59:59.999Z", "2026-07-16T00:00:00.000Z"],
    );
    const repository = new PostgresRetentionRepository(database);
    await expect(repository.deletePriceSnapshotsBefore("2026-07-16T00:00:00.000Z")).resolves.toBe(1);
    const remaining = await database.query<{ capturedAt: Date }>(
      `SELECT captured_at AS "capturedAt" FROM price_snapshots`,
    );
    expect(remaining.rows[0]?.capturedAt.toISOString()).toBe("2026-07-16T00:00:00.000Z");
  });

  it("日志截止点相等记录保留且更早记录删除", async () => {
    await database.query(
      `INSERT INTO fetch_logs (source, status, captured_at)
       VALUES ('test', 'failed', $1), ('test', 'success', $2)`,
      ["2026-07-15T23:59:59.999Z", "2026-07-16T00:00:00.000Z"],
    );
    await expect(new PostgresRetentionRepository(database).deleteFetchLogsBefore("2026-07-16T00:00:00.000Z")).resolves.toBe(1);
  });
});

async function seedProduct(database: AppDatabase): Promise<void> {
  // 参数化夹具只建立价格外键要求的最小业务主档，不调用尚属 Task 4 的订阅写事务。
  await database.query(
    "INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)",
    ["game-retention", "保留测试", "Retention Test", "game"],
  );
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ["product-retention", "game-retention", "US", "USD", "https://example.test/us", "manual-link"],
  );
}
