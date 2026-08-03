import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RetentionRepository } from "../src/repositories/postgres/retention-repository";
import { runMigrations } from "../src/server/database/migrations";
import { RetentionService } from "../src/services/retention-service";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("RetentionRepository", () => {
  // 使用真实 PostgreSQL 验证 TIMESTAMPTZ 删除边界；保留相等时刻可避免维护任务比管理员配置更早丢弃历史。
  const database = createTestDatabase();
  const retention = new RetentionRepository(database);

  beforeAll(async () => {
    // 每个转换后的文件都从正式迁移建立空 schema，确保测试验证生产列类型和外键，而不是手工简化表。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 显式关闭池，避免保留测试完成后仍持有 disposable 数据库连接。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 只清理 disposable schema；统一重置 identity 使删除计数与排序断言不受前一用例影响。
    await database.query("TRUNCATE games, regional_products, price_snapshots, fetch_logs RESTART IDENTITY CASCADE");
    await database.query(
      "INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)",
      ["game-retention", "保留策略测试游戏", "Retention Test Game", "game"],
    );
    await database.query(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)",
      ["product-retention", "game-retention", "US", "USD", "https://example.test/us", "manual-link"],
    );
  });

  it("deletes only price snapshots older than the configured cutoff", async () => {
    // 截止点前、恰在截止点和截止点后各写一条，验证 SQL 使用严格小于而不是小于等于。
    await insertSnapshots(database, [
      [1000, "2025-07-15T23:59:59.999Z"],
      [900, "2025-07-16T00:00:00.000Z"],
      [800, "2025-07-16T00:00:00.001Z"],
    ]);

    await expect(retention.deletePriceSnapshotsBefore("2025-07-16T00:00:00.000Z")).resolves.toBe(1);
    const remaining = await database.query<{ amountMinor: number }>("SELECT amount_minor AS \"amountMinor\" FROM price_snapshots ORDER BY captured_at");
    expect(remaining.rows).toEqual([{ amountMinor: 900 }, { amountMinor: 800 }]);
  });

  it("deletes only fetch logs older than the fixed diagnostic cutoff", async () => {
    // 日志清理必须独立于价格策略；同样保留边界记录以便恰好 90 天前的故障仍可被管理员查看。
    await insertLogs(database, [
      ["failed", "2026-04-16T23:59:59.999Z"],
      ["failed", "2026-04-17T00:00:00.000Z"],
      ["success", "2026-04-17T00:00:00.001Z"],
    ]);

    await expect(retention.deleteFetchLogsBefore("2026-04-17T00:00:00.000Z")).resolves.toBe(1);
    const remaining = await database.query<{ status: string }>("SELECT status FROM fetch_logs ORDER BY captured_at");
    expect(remaining.rows).toEqual([{ status: "failed" }, { status: "success" }]);
  });

  it("applies the selected price policy while always cleaning ninety-day diagnostic logs", async () => {
    // 这个集成用例同时验证策略层不会在永久保留时误删价格，并确保日志不会因为价格策略不同而停止清理。
    const service = new RetentionService(retention);
    await insertSnapshots(database, [[1000, "2025-07-15T23:59:59.999Z"], [900, "2025-07-16T00:00:00.000Z"]]);
    await insertLogs(database, [["failed", "2026-04-16T23:59:59.999Z"], ["success", "2026-04-17T00:00:00.000Z"]]);

    await expect(service.cleanup("2026-07-16T00:00:00.000Z", "one-year")).resolves.toEqual({
      priceSnapshotsDeleted: 1,
      fetchLogsDeleted: 1,
    });
    const prices = await database.query<{ count: string }>("SELECT COUNT(*) AS count FROM price_snapshots");
    const logs = await database.query<{ count: string }>("SELECT COUNT(*) AS count FROM fetch_logs");
    expect(prices.rows[0]?.count).toBe("1");
    expect(logs.rows[0]?.count).toBe("1");
  });
});

/** 批量夹具仍逐条使用 `$1` 参数，金额保持整数最小单位，避免测试辅助代码本身引入浮点或 SQL 拼接差异。 */
async function insertSnapshots(database: ReturnType<typeof createTestDatabase>, rows: Array<[number, string]>): Promise<void> {
  for (const [amountMinor, capturedAt] of rows) {
    await database.query(
      `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["product-retention", amountMinor, "USD", amountMinor * 7, "official", capturedAt],
    );
  }
}

/** 日志夹具只保存受控状态与时间，不写外部响应正文，保持数据保留测试的敏感信息边界。 */
async function insertLogs(database: ReturnType<typeof createTestDatabase>, rows: Array<[string, string]>): Promise<void> {
  for (const [status, capturedAt] of rows) {
    await database.query(
      "INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES ($1, $2, $3, $4)",
      ["product-retention", "official", status, capturedAt],
    );
  }
}
