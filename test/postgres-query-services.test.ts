import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import type { AppDatabase } from "../src/server/database/types";
import { DashboardService } from "../src/services/dashboard-service";
import { ExportService } from "../src/services/export-service";
import { HistoryService } from "../src/services/history-service";
import { PostgresDashboardRepository } from "../src/repositories/postgres/dashboard-repository";
import { PostgresExportRepository } from "../src/repositories/postgres/export-repository";
import { PostgresHistoryRepository } from "../src/repositories/postgres/history-repository";
import { createTestDatabase, POSTGRES_MIGRATION_DIRECTORY, resetTestSchema } from "./support/postgres";

describe("PostgreSQL 仪表盘、历史与导出查询服务", () => {
  let database: AppDatabase;
  beforeAll(async () => { database = await createTestDatabase(); });
  beforeEach(async () => {
    // 每例重建并插入相同只读夹具，确保三项服务共享 DTO 行为而不依赖 Task 4 的认证/订阅写服务。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
    await seedQueries(database);
  });
  afterAll(async () => { await database.close(); });

  it("聚合当前价、历史低价、健康状态与管理员日报时区", async () => {
    const overview = await new DashboardService(new PostgresDashboardRepository(database))
      .getOverview(new Date("2026-07-16T00:00:00.000Z"));
    expect(overview.stats).toEqual({
      monitoredSubscriptionCount: 1,
      availableRegionPriceCount: 1,
      lastCapturedAt: "2026-07-16T06:00:00.000Z",
      timezone: "Asia/Shanghai",
      nextDailyReportAt: "2026-07-16T01:00:00.000Z",
    });
    expect(overview.subscriptions[0]?.regions[0]).toEqual({
      regionalProductId: "product-query",
      regionCode: "US",
      currency: "USD",
      current: { amountMinor: 899, cnyFen: 6200, source: "official", capturedAt: "2026-07-16T06:00:00.000Z" },
      historicalLow: { amountMinor: 899, cnyFen: 6200, source: "official", capturedAt: "2026-07-16T06:00:00.000Z" },
      isStale: true,
    });
  });

  it("历史筛选使用参数且相同时间按 identity 稳定排序", async () => {
    const history = await new HistoryService(new PostgresHistoryRepository(database)).list("subscription-query", "US");
    expect(history.snapshots.map((snapshot) => snapshot.amountMinor)).toEqual([999, 899]);
    expect(history.snapshots.every((snapshot) => snapshot.capturedAt === "2026-07-16T06:00:00.000Z")).toBe(true);
  });

  it("三种 CSV 使用固定白名单且不包含认证哨兵值", async () => {
    const secretSentinel = "AUTH_SECRET_MUST_NOT_EXPORT";
    await database.query(
      `INSERT INTO admin_credentials (
         id, password_hash, password_salt, recovery_hash, recovery_salt, created_at
       ) VALUES (1, $1, $2, $3, $4, $5)`,
      [secretSentinel, "salt", "recovery", "recovery-salt", "2026-07-16T00:00:00.000Z"],
    );
    const service = new ExportService(new PostgresExportRepository(database));
    const outputs = await Promise.all([service.pricesCsv(), service.subscriptionsCsv(), service.fetchLogsCsv()]);
    expect(outputs.join("\n")).not.toContain(secretSentinel);
    expect(outputs[0]).toContain("region_code,amount_minor,currency,cny_fen,source,captured_at");
    expect(outputs[1]).toContain("subscription_id,game_id,enabled,region_code,regional_product_id");
    expect(outputs[2]).toContain("region_code,source,status,message,captured_at");
  });
});

async function seedQueries(database: AppDatabase): Promise<void> {
  // 所有动态夹具值均参数化；固定 SQL 只建立读查询所需列，刻意不写 Telegram 或真实凭据。
  await database.query(
    `INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at)
     VALUES (1, $1::jsonb, 'US', $2, $2)`,
    [JSON.stringify(["US"]), "2026-07-16T00:00:00.000Z"],
  );
  await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ('game-query', '查询测试', 'Query Test', 'game')");
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source)
     VALUES ('product-query', 'game-query', 'US', 'USD', 'https://example.test/us', 'manual-link')`,
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
     VALUES ('subscription-query', 'game-query', TRUE, $1, $1)`,
    ["2026-07-16T00:00:00.000Z"],
  );
  await database.query("INSERT INTO subscription_regions VALUES ('subscription-query', 'product-query')");
  await database.query(
    `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at)
     VALUES ('product-query', 999, 'USD', 6800, 'official', $1),
            ('product-query', 899, 'USD', 6200, 'official', $1)`,
    ["2026-07-16T06:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO regional_product_health (regional_product_id, consecutive_failures, failure_notified)
     VALUES ('product-query', 1, FALSE)`,
  );
  await database.query(
    `INSERT INTO fetch_logs (regional_product_id, source, status, message, captured_at)
     VALUES ('product-query', 'official', 'success', '价格已读取', $1)`,
    ["2026-07-16T06:00:00.000Z"],
  );
}
