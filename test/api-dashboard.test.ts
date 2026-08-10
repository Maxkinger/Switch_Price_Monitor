import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import {
  createApiTestDatabase,
  createTestNodeDispatcher,
  initializeAndLogin as initializeAdmin,
  jsonRequest,
  resetApiTestData,
} from "./support/api-postgres";

// 文件级夹具函数共享同一受守卫连接池；afterAll 会显式关闭，禁止测试进程遗留数据库连接。
let database: AppDatabase;

describe("dashboard HTTP route", () => {
  beforeAll(async () => {
    database = await createApiTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    // 仪表盘从订阅与价格历史派生；清空受守卫的一次性库确保空状态不受其他用例留下的快照影响。
    await resetApiTestData(database);
  });

  it("returns an authenticated empty subscription overview before any game is added", async () => {
    // 空仪表盘是首次初始化后的正常状态，必须返回稳定数组而不是把没有订阅误报成服务器错误。
    const cookie = await initializeAndLogin();
    const response = await call("/api/dashboard", cookie);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      // 首次初始化时不应伪造采集记录；日报计划来自已保存的全局设置，因此仍可安全给出下一次执行时间。
      stats: {
        monitoredSubscriptionCount: 0,
        availableRegionPriceCount: 0,
        lastCapturedAt: null,
        // 公开时区让浏览器按管理员保存的日报口径格式化 UTC 时间，避免把传输层 ISO 直接展示给用户。
        timezone: "Asia/Shanghai",
        nextDailyReportAt: expect.any(String),
      },
      subscriptions: [],
    });
  });

  it("lists an existing subscription with its game identity and selected regional products", async () => {
    // 即使尚未采集到价格，管理员也必须在仪表盘看到已创建订阅，才能判断系统正在等待首次采集而非丢失配置。
    const cookie = await initializeAndLogin();
    await seedSubscription();
    const response = await call("/api/dashboard", cookie);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      stats: {
        monitoredSubscriptionCount: 1,
        availableRegionPriceCount: 0,
        lastCapturedAt: null,
        timezone: "Asia/Shanghai",
        nextDailyReportAt: expect.any(String),
      },
      subscriptions: [
        {
          subscriptionId: "subscription-overcooked-2",
          gameId: "game-overcooked-2",
          displayNameZhCn: "胡闹厨房 2",
          nameZh: "旧中文候选",
          nameEn: "Overcooked! 2",
          enabled: true,
          regionalProductIds: ["product-overcooked-2-us"],
          allRegionHistoricalLow: null,
          regions: [
            {
              regionalProductId: "product-overcooked-2-us",
              regionCode: "US",
              currency: "USD",
              current: null,
              historicalLow: null,
              // 从未成功采集的地区应显示等待首笔价格，而不是被健康表的默认零失败数误标为过期。
              isStale: false,
            },
          ],
        },
      ],
    });
  });

  it("uses converted CNY values to select one all-region historical low", async () => {
    // 跨区比较不能拿美元分与日元分直接比大小；该断言固定使用已保存的人民币分，验证最便宜区遵循同一购买成本口径。
    const cookie = await initializeAndLogin();
    await seedSubscription();
    await database.transaction(async (transaction) => {
      await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)", ["product-overcooked-2-jp", "game-overcooked-2", "JP", "JPY", "https://example.test/jp", "manual_selection"]);
      await transaction.query("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)", ["subscription-overcooked-2", "product-overcooked-2-jp"]);
      await insertPrice(transaction, "product-overcooked-2-us", 999, "USD", 6800, "official", "2026-07-15T00:00:00.000Z");
      await insertPrice(transaction, "product-overcooked-2-jp", 1000, "JPY", 4200, "official", "2026-07-14T00:00:00.000Z");
    });
    const response = await call("/api/dashboard", cookie);
    const body = await response.json() as { subscriptions: Array<{ allRegionHistoricalLow: unknown }> };

    expect(response.status).toBe(200);
    expect(body.subscriptions[0].allRegionHistoricalLow).toEqual({
      regionalProductId: "product-overcooked-2-jp",
      regionCode: "JP",
      amountMinor: 1000,
      currency: "JPY",
      cnyFen: 4200,
      source: "official",
      capturedAt: "2026-07-14T00:00:00.000Z",
    });
  });

  it("returns the latest snapshot and the regional historical low without treating a third-party result as official", async () => {
    // 当前价按最新采集时间选择，历史最低价按本币最小金额选择；来源字段必须原样返回，让前端清楚标记第三方数据。
    const cookie = await initializeAndLogin();
    await seedSubscription();
    await database.transaction(async (transaction) => {
      await insertPrice(transaction, "product-overcooked-2-us", 999, "USD", 6800, "official", "2026-07-15T00:00:00.000Z");
      await insertPrice(transaction, "product-overcooked-2-us", 1099, "USD", 7450, "eshop-prices", "2026-07-16T00:00:00.000Z");
    });
    const response = await call("/api/dashboard", cookie);
    const body = await response.json() as { subscriptions: Array<{ regions: Array<{ current: unknown; historicalLow: unknown }> }> };

    expect(response.status).toBe(200);
    expect(body.subscriptions[0].regions[0]).toEqual({
      regionalProductId: "product-overcooked-2-us",
      regionCode: "US",
      currency: "USD",
      current: { amountMinor: 1099, cnyFen: 7450, source: "eshop-prices", capturedAt: "2026-07-16T00:00:00.000Z" },
      historicalLow: { amountMinor: 999, cnyFen: 6800, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
      isStale: false,
    });
  });

  it("returns dashboard statistics and marks a region stale after collection failures", async () => {
    // 一次成功快照后出现连续失败时，仍可展示最近可信价格，但必须让管理员知道它不是本轮实时结果。
    const cookie = await initializeAndLogin();
    await seedSubscription();
    await database.transaction(async (transaction) => {
      await insertPrice(transaction, "product-overcooked-2-us", 999, "USD", 6800, "official", "2026-07-16T00:00:00.000Z");
      await insertPrice(transaction, "product-overcooked-2-us", 1099, "USD", 7450, "official", "2026-07-17T00:00:00.000Z");
      await transaction.query("INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at) VALUES ($1, $2, $3, $4, $5)", ["product-overcooked-2-us", 1, "2026-07-17T00:00:00.000Z", false, "2026-07-17T06:00:00.000Z"]);
    });

    const response = await call("/api/dashboard", cookie);
    const body = await response.json() as {
      stats: { monitoredSubscriptionCount: number; availableRegionPriceCount: number; lastCapturedAt: string | null; timezone: string; nextDailyReportAt: string | null };
      subscriptions: Array<{ regions: Array<{ isStale: boolean }> }>;
    };

    expect(response.status).toBe(200);
    expect(body.stats).toEqual({
      monitoredSubscriptionCount: 1,
      availableRegionPriceCount: 1,
      lastCapturedAt: "2026-07-17T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      nextDailyReportAt: expect.any(String),
    });
    expect(body.subscriptions[0].regions[0].isStale).toBe(true);
  });
});

async function seedSubscription(): Promise<void> {
  // 直接构造已完成匹配和订阅确认的数据状态；事务防止夹具失败留下会影响读取断言的半成品。
  await database.transaction(async (transaction) => {
    // legacy name_zh 与新字段故意使用不同文本；若查询错误回退旧列，API 断言会得到“旧中文候选”而失败。
    await transaction.query("INSERT INTO games (id, name_zh, name_en, product_type, display_name_zh_cn, display_name_source, display_name_confirmed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", ["game-overcooked-2", "旧中文候选", "Overcooked! 2", "game", "胡闹厨房 2", "manual", "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)", ["product-overcooked-2-us", "game-overcooked-2", "US", "USD", "https://example.test/us", "manual_selection"]);
    await transaction.query("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", ["subscription-overcooked-2", "game-overcooked-2", true, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)", ["subscription-overcooked-2", "product-overcooked-2-us"]);
  });
}

async function initializeAndLogin(): Promise<string> {
  // 使用真实 PostgreSQL 认证路由取得会话，确保仪表盘与所有管理页面共享同一摘要校验边界。
  return (await initializeAdmin(database, { enabledRegions: ["US"], defaultSearchRegion: "US" })).cookie;
}

async function call(path: string, cookie: string): Promise<Response> {
  // 真实 Node dispatcher 必须注册仪表盘路由；null 表示路由遗漏而不是可接受的静态回退。
  const response = await createTestNodeDispatcher(database)(jsonRequest(path, undefined, cookie, "GET"));
  if (!response) throw new Error("仪表盘测试请求未被 Node API 处理");
  return response;
}

/** 价格夹具统一使用 PostgreSQL 参数绑定；金额保持整数最小单位，测试来源不会进入生产数据。 */
async function insertPrice(transaction: SqlExecutor, productId: string, amountMinor: number, currency: string, cnyFen: number, source: string, capturedAt: string): Promise<void> {
  await transaction.query("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6)", [productId, amountMinor, currency, cnyFen, source, capturedAt]);
}
