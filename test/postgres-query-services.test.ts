import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import type { AppDatabase } from "../src/server/database/types";
import { DashboardService } from "../src/services/dashboard-service";
import { ExportService } from "../src/services/export-service";
import { HistoryService } from "../src/services/history-service";
import { PostgresDashboardRepository } from "../src/repositories/postgres/dashboard-repository";
import { PostgresExportRepository } from "../src/repositories/postgres/export-repository";
import { PostgresHistoryRepository } from "../src/repositories/postgres/history-repository";
import type { ExportReader } from "../src/repositories/ports";
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

  it("聚合跨区最低价、停用订阅、空快照与管理员日报时区", async () => {
    const overview = await new DashboardService(new PostgresDashboardRepository(database))
      .getOverview(new Date("2026-07-16T00:00:00.000Z"));
    expect(overview.stats).toEqual({
      monitoredSubscriptionCount: 1,
      availableRegionPriceCount: 2,
      lastCapturedAt: "2026-07-16T07:00:00.000Z",
      timezone: "Asia/Shanghai",
      nextDailyReportAt: "2026-07-16T01:00:00.000Z",
    });
    expect(overview.subscriptions[0]).toEqual({
      subscriptionId: "subscription-query",
      gameId: "game-query",
      nameZh: "查询测试",
      nameEn: "Query Test",
      enabled: true,
      regionalProductIds: ["product-hk", "product-jp", "product-query"],
      // JP 两笔 cnyFen/时间完全相同；跨区窗口排序必须用更早 identity 固定选择第一笔，而不是返回不稳定行。
      allRegionHistoricalLow: {
        regionalProductId: "product-jp",
        regionCode: "JP",
        amountMinor: 1000,
        currency: "JPY",
        cnyFen: 5000,
        source: "official",
        capturedAt: "2026-07-16T07:00:00.000Z",
      },
      regions: [
        {
          regionalProductId: "product-query",
          regionCode: "US",
          currency: "USD",
          current: { amountMinor: 899, cnyFen: 6200, source: "official", capturedAt: "2026-07-16T06:00:00.000Z" },
          historicalLow: { amountMinor: 899, cnyFen: 6200, source: "official", capturedAt: "2026-07-16T06:00:00.000Z" },
          isStale: true,
        },
        {
          regionalProductId: "product-jp",
          regionCode: "JP",
          currency: "JPY",
          // 同时间的地区当前价按较新 identity 选择第二笔；本地最低价也按金额选择第二笔，与跨区 cnyFen 排名语义不同。
          current: { amountMinor: 900, cnyFen: 5000, source: "official", capturedAt: "2026-07-16T07:00:00.000Z" },
          historicalLow: { amountMinor: 900, cnyFen: 5000, source: "official", capturedAt: "2026-07-16T07:00:00.000Z" },
          isStale: false,
        },
        {
          regionalProductId: "product-hk",
          regionCode: "HK",
          currency: "HKD",
          current: null,
          historicalLow: null,
          isStale: false,
        },
      ],
    });
    expect(overview.subscriptions[1]).toMatchObject({
      subscriptionId: "subscription-disabled",
      gameId: "game-disabled",
      nameZh: "停用查询",
      nameEn: "Disabled Query",
      enabled: false,
      regionalProductIds: ["product-mx-disabled"],
      // 停用订阅仍完整返回供恢复；其低价和当前价不得进入顶部 monitored/available/lastCapturedAt 统计。
      allRegionHistoricalLow: {
        regionalProductId: "product-mx-disabled",
        regionCode: "MX",
        cnyFen: 1000,
      },
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

  it("CSV 中和电子表格公式触发前缀并保持数字、列头与 CRLF 结构", async () => {
    const formulaPayloads = [
      "=ascii-equals",
      "+ascii-plus",
      "-ascii-minus",
      "@ascii-at",
      "\ttab",
      "\rcarriage-return",
      "\nline-feed",
      "＝full-width-equals",
      "＋full-width-plus",
      "－full-width-minus",
      "＠full-width-at",
    ];
    const exports: ExportReader = {
      // 负数是受控数字字段，不应因序列化后以减号开头而被当作电子表格公式文本加前缀。
      async prices() {
        return [{ regionCode: "US", amountMinor: -100, currency: "USD", cnyFen: null, source: "official", capturedAt: "2026-07-16T00:00:00.000Z" }];
      },
      async subscriptions() { return []; },
      async fetchLogs() {
        return formulaPayloads.map((message) => ({
          regionCode: "US",
          source: "test",
          status: "success",
          message,
          capturedAt: "2026-07-16T00:00:00.000Z",
        }));
      },
    };
    const service = new ExportService(exports);

    expect(await service.pricesCsv()).toBe(
      "region_code,amount_minor,currency,cny_fen,source,captured_at\r\n" +
      "\"US\",\"-100\",\"USD\",\"\",\"official\",\"2026-07-16T00:00:00.000Z\"",
    );
    expect(await service.fetchLogsCsv()).toBe([
      "region_code,source,status,message,captured_at",
      "\"US\",\"test\",\"success\",\"'=ascii-equals\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'+ascii-plus\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'-ascii-minus\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'@ascii-at\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'\ttab\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'\rcarriage-return\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'\nline-feed\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'＝full-width-equals\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'＋full-width-plus\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'－full-width-minus\",\"2026-07-16T00:00:00.000Z\"",
      "\"US\",\"test\",\"success\",\"'＠full-width-at\",\"2026-07-16T00:00:00.000Z\"",
    ].join("\r\n"));
  });
});

async function seedQueries(database: AppDatabase): Promise<void> {
  // 所有动态夹具值均参数化；固定 SQL 只建立读查询所需列，刻意不写 Telegram 或真实凭据。
  await database.query(
    `INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at)
     VALUES (1, $1::jsonb, 'US', $2, $2)`,
    [JSON.stringify(["US", "JP", "HK", "MX"]), "2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO games (id, name_zh, name_en, product_type)
     VALUES ('game-query', '查询测试', 'Query Test', 'game'),
            ('game-disabled', '停用查询', 'Disabled Query', 'game')`,
  );
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at)
     VALUES ('product-query', 'game-query', 'US', 'USD', 'https://example.test/us', 'manual-link', $1),
            ('product-jp', 'game-query', 'JP', 'JPY', 'https://example.test/jp', 'manual-link', $2),
            ('product-hk', 'game-query', 'HK', 'HKD', 'https://example.test/hk', 'manual-link', $3),
            ('product-mx-disabled', 'game-disabled', 'MX', 'MXN', 'https://example.test/mx', 'manual-link', $4)`,
    [
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T01:00:00.000Z",
      "2026-07-16T02:00:00.000Z",
      "2026-07-16T03:00:00.000Z",
    ],
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
     VALUES ('subscription-query', 'game-query', TRUE, $1, $1),
            ('subscription-disabled', 'game-disabled', FALSE, $2, $2)`,
    ["2026-07-16T00:00:00.000Z", "2026-07-16T01:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO subscription_regions (subscription_id, regional_product_id)
     VALUES ('subscription-query', 'product-query'),
            ('subscription-query', 'product-jp'),
            ('subscription-query', 'product-hk'),
            ('subscription-disabled', 'product-mx-disabled')`,
  );
  await database.query(
    `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at)
     VALUES ('product-query', 999, 'USD', 6800, 'official', $1),
            ('product-query', 899, 'USD', 6200, 'official', $1),
            ('product-jp', 1000, 'JPY', 5000, 'official', $2),
            ('product-jp', 900, 'JPY', 5000, 'official', $2),
            ('product-mx-disabled', 100, 'MXN', 1000, 'official', $3)`,
    [
      "2026-07-16T06:00:00.000Z",
      "2026-07-16T07:00:00.000Z",
      "2026-07-16T08:00:00.000Z",
    ],
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
