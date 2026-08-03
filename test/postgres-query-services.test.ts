import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DashboardRepository } from "../src/repositories/postgres/dashboard-repository";
import { ExportRepository } from "../src/repositories/postgres/export-repository";
import { HistoryRepository } from "../src/repositories/postgres/history-repository";
import { runMigrations } from "../src/server/database/migrations";
import type { SqlExecutor } from "../src/server/database/types";
import { DashboardService } from "../src/services/dashboard-service";
import { ExportService } from "../src/services/export-service";
import { HistoryService } from "../src/services/history-service";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("PostgreSQL query services", () => {
  // 三个查询服务共享一个可丢弃 PostgreSQL，但各自只接收窄读取端口，服务永远看不到 SQL、pg client 或数据库行。
  const database = createTestDatabase();

  beforeAll(async () => {
    // 固定回环目标和 disposable marker 双重校验通过后才允许重建 schema；随后运行与生产相同的不可变迁移。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 关闭共享测试池，防止查询服务用例留下连接并阻止 Vitest 正常退出。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 只清理专用测试 schema，并重置所有 BIGINT identity，让相同时间的价格与日志排序可重复。
    await database.query(
      `TRUNCATE settings, games, regional_products, subscriptions, subscription_regions,
                subscription_region_targets, price_snapshots, fetch_logs, regional_product_health,
                notification_events, admin_credentials, sessions, login_attempts
       RESTART IDENTITY CASCADE`,
    );
  });

  it("builds dashboard DTOs with stable snapshot ordering and excludes paused subscriptions from statistics", async () => {
    // 暂停订阅仍需显示供恢复，但它的价格不能进入监控数、可用价格数或最后采集时间；相同时间的 current 以较大 id 决胜。
    await seedDashboard(database);
    const service = new DashboardService(new DashboardRepository(database));

    await expect(service.getOverview(new Date("2026-07-16T00:00:00.000Z"))).resolves.toEqual({
      stats: {
        monitoredSubscriptionCount: 1,
        availableRegionPriceCount: 1,
        lastCapturedAt: "2026-07-16T00:00:00.000Z",
        timezone: "Asia/Shanghai",
        nextDailyReportAt: "2026-07-16T01:00:00.000Z",
      },
      subscriptions: [
        {
          subscriptionId: "subscription-active",
          gameId: "game-active",
          nameZh: "活跃游戏",
          nameEn: "Active Game",
          enabled: true,
          regionalProductIds: ["product-active-jp", "product-active-us"],
          allRegionHistoricalLow: { regionalProductId: "product-active-us", regionCode: "US", amountMinor: 899, currency: "USD", cnyFen: 6100, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
          regions: [
            {
              regionalProductId: "product-active-us",
              regionCode: "US",
              currency: "USD",
              current: { amountMinor: 1099, cnyFen: 7450, source: "eshop-prices", capturedAt: "2026-07-16T00:00:00.000Z" },
              historicalLow: { amountMinor: 899, cnyFen: 6100, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
              isStale: true,
            },
            {
              regionalProductId: "product-active-jp",
              regionCode: "JP",
              currency: "JPY",
              current: null,
              historicalLow: null,
              isStale: false,
            },
          ],
        },
        {
          subscriptionId: "subscription-paused",
          gameId: "game-paused-dashboard",
          nameZh: "暂停游戏",
          nameEn: "Paused Game",
          enabled: false,
          regionalProductIds: ["product-paused-hk"],
          allRegionHistoricalLow: { regionalProductId: "product-paused-hk", regionCode: "HK", amountMinor: 5000, currency: "HKD", cnyFen: 4600, source: "official", capturedAt: "2026-07-17T00:00:00.000Z" },
          regions: [{
            regionalProductId: "product-paused-hk",
            regionCode: "HK",
            currency: "HKD",
            current: { amountMinor: 5000, cnyFen: 4600, source: "official", capturedAt: "2026-07-17T00:00:00.000Z" },
            historicalLow: { amountMinor: 5000, cnyFen: 4600, source: "official", capturedAt: "2026-07-17T00:00:00.000Z" },
            isStale: false,
          }],
        },
      ],
    });
  });

  it("lists immutable history in capture and identity order and applies a parameterized region filter", async () => {
    // 同一捕获时间的两条记录按 identity 升序，曲线和 CSV 才能复现写入顺序；地区筛选在数据库执行而不是让浏览器下载其他地区。
    await seedHistory(database);
    const service = new HistoryService(new HistoryRepository(database));

    await expect(service.list("subscription-history", null)).resolves.toEqual({ snapshots: [
      { regionCode: "JP", amountMinor: 1000, currency: "JPY", cnyFen: 4200, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
      { regionCode: "US", amountMinor: 999, currency: "USD", cnyFen: 6800, source: "official", capturedAt: "2026-07-16T00:00:00.000Z" },
      { regionCode: "US", amountMinor: 1099, currency: "USD", cnyFen: 7450, source: "eshop-prices", capturedAt: "2026-07-16T00:00:00.000Z" },
    ] });
    await expect(service.list("subscription-history", "JP")).resolves.toEqual({ snapshots: [
      { regionCode: "JP", amountMinor: 1000, currency: "JPY", cnyFen: 4200, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
    ] });
  });

  it("exports only allowlisted business columns with ISO timestamps, nullable joins, and escaped CSV cells", async () => {
    // 记录全部查询文本以验证仓储从未读取认证、会话或 Telegram 字段；真实秘密标记也不得出现在任何 CSV 内容中。
    await seedExports(database);
    const statements: string[] = [];
    const recordingExecutor: SqlExecutor = {
      async query<Row>(sql: string, parameters?: readonly unknown[]) {
        statements.push(sql);
        return database.query<Row>(sql, parameters);
      },
    };
    const service = new ExportService(new ExportRepository(recordingExecutor));

    const prices = await service.pricesCsv();
    const subscriptions = await service.subscriptionsCsv();
    const logs = await service.fetchLogsCsv();
    const combinedOutput = [prices, subscriptions, logs].join("\n");
    const combinedSql = statements.join("\n");

    expect(prices).toContain('"US","999","USD","6800","official","2026-07-16T00:00:00.000Z"');
    expect(subscriptions).toContain('"subscription-export","game-export","0","",""');
    expect(logs).toContain('"","official","success","价格,""已读取""","2026-07-16T01:00:00.000Z"');
    expect(combinedOutput).not.toContain("secret-password-hash");
    expect(combinedOutput).not.toContain("secret-session-token-hash");
    expect(combinedOutput.toLowerCase()).not.toContain("telegram");
    expect(combinedSql).not.toMatch(/admin_credentials|sessions|password|recovery|token|telegram/i);
  });
});

/** 构造活跃与暂停订阅，集中覆盖 BOOLEAN、空快照 LEFT JOIN、跨区最低价和相同时间最新价的 PostgreSQL 行为。 */
async function seedDashboard(database: ReturnType<typeof createTestDatabase>): Promise<void> {
  await database.query(
    `INSERT INTO settings (id, enabled_regions_json, default_search_region, timezone, daily_report_time, created_at, updated_at)
     VALUES (1, $1::jsonb, $2, $3, $4, $5, $5)`,
    [JSON.stringify(["US", "JP"]), "US", "Asia/Shanghai", "09:00", "2026-07-14T00:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO games (id, name_zh, name_en, product_type, created_at)
     VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $4, $9)`,
    ["game-active", "活跃游戏", "Active Game", "game", "2026-07-14T00:00:00.000Z", "game-paused-dashboard", "暂停游戏", "Paused Game", "2026-07-14T01:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $2, $9, $10, $11, $6, $12), ($13, $14, $15, $16, $17, $6, $18)`,
    [
      "product-active-us", "game-active", "US", "USD", "https://example.test/us", "manual_selection", "2026-07-14T00:10:00.000Z",
      "product-active-jp", "JP", "JPY", "https://example.test/jp", "2026-07-14T00:20:00.000Z",
      "product-paused-hk", "game-paused-dashboard", "HK", "HKD", "https://example.test/hk", "2026-07-14T01:10:00.000Z",
    ],
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
     VALUES ($1, $2, TRUE, $3, $3), ($4, $5, FALSE, $6, $6)`,
    ["subscription-active", "game-active", "2026-07-14T00:00:00.000Z", "subscription-paused", "game-paused-dashboard", "2026-07-14T01:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO subscription_regions (subscription_id, regional_product_id)
     VALUES ($1, $2), ($1, $3), ($4, $5)`,
    ["subscription-active", "product-active-us", "product-active-jp", "subscription-paused", "product-paused-hk"],
  );
  await insertDashboardSnapshot(database, "product-active-us", 899, "USD", 6100, "official", "2026-07-15T00:00:00.000Z");
  await insertDashboardSnapshot(database, "product-active-us", 999, "USD", 6800, "official", "2026-07-16T00:00:00.000Z");
  await insertDashboardSnapshot(database, "product-active-us", 1099, "USD", 7450, "eshop-prices", "2026-07-16T00:00:00.000Z");
  await insertDashboardSnapshot(database, "product-paused-hk", 5000, "HKD", 4600, "official", "2026-07-17T00:00:00.000Z");
  await database.query(
    `INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at)
     VALUES ($1, 1, $2, FALSE, $3)`,
    ["product-active-us", "2026-07-16T00:00:00.000Z", "2026-07-16T06:00:00.000Z"],
  );
}

/** 仪表盘价格夹具保持整数最小单位与参数化来源，避免测试辅助层自行换算或拼接来源。 */
async function insertDashboardSnapshot(database: ReturnType<typeof createTestDatabase>, productId: string, amountMinor: number, currency: string, cnyFen: number, source: string, capturedAt: string): Promise<void> {
  await database.query(
    `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [productId, amountMinor, currency, cnyFen, source, capturedAt],
  );
}

/** 历史夹具用两区和同时间双快照验证订阅归属、参数化地区过滤及 identity 次序。 */
async function seedHistory(database: ReturnType<typeof createTestDatabase>): Promise<void> {
  await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["game-history", "历史游戏", "History Game", "game"]);
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source)
     VALUES ($1, $2, $3, $4, $5, $6), ($7, $2, $8, $9, $10, $6)`,
    ["product-history-jp", "game-history", "JP", "JPY", "https://example.test/jp", "manual_selection", "product-history-us", "US", "USD", "https://example.test/us"],
  );
  await database.query("INSERT INTO subscriptions (id, game_id, enabled) VALUES ($1, $2, TRUE)", ["subscription-history", "game-history"]);
  await database.query(
    "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2), ($1, $3)",
    ["subscription-history", "product-history-jp", "product-history-us"],
  );
  await insertDashboardSnapshot(database, "product-history-jp", 1000, "JPY", 4200, "official", "2026-07-15T00:00:00.000Z");
  await insertDashboardSnapshot(database, "product-history-us", 999, "USD", 6800, "official", "2026-07-16T00:00:00.000Z");
  await insertDashboardSnapshot(database, "product-history-us", 1099, "USD", 7450, "eshop-prices", "2026-07-16T00:00:00.000Z");
}

/** 导出夹具写入真实认证秘密标记但不关联导出查询，并构造空地区订阅和空商品日志以覆盖安全 LEFT JOIN。 */
async function seedExports(database: ReturnType<typeof createTestDatabase>): Promise<void> {
  await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["game-export", "导出游戏", "Export Game", "game"]);
  await database.query(
    "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)",
    ["product-export-us", "game-export", "US", "USD", "https://example.test/us", "manual_selection"],
  );
  await database.query(
    "INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, FALSE, $3, $3)",
    ["subscription-export", "game-export", "2026-07-15T00:00:00.000Z"],
  );
  await insertDashboardSnapshot(database, "product-export-us", 999, "USD", 6800, "official", "2026-07-16T00:00:00.000Z");
  await database.query(
    "INSERT INTO fetch_logs (regional_product_id, source, status, message, captured_at) VALUES (NULL, $1, $2, $3, $4)",
    ["official", "success", '价格,"已读取"', "2026-07-16T01:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO admin_credentials (id, password_hash, password_salt, recovery_hash, recovery_salt, created_at)
     VALUES (1, $1, $2, $3, $4, $5)`,
    ["secret-password-hash", "salt", "secret-recovery-hash", "recovery-salt", "2026-07-14T00:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)",
    ["session-export", "secret-session-token-hash", "2026-07-20T00:00:00.000Z", "2026-07-14T00:00:00.000Z"],
  );
}
