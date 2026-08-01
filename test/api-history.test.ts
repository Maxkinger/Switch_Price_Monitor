import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/database/types";
import { createApiTestDatabase, createTestNodeDispatcher, initializeAndLogin, jsonRequest, resetApiTestData } from "./support/api-postgres";

// 文件级查询夹具与路由 helper 共享同一受守卫连接池；文件结束后显式关闭，避免 pg 句柄阻止 Vitest 退出。
let database: AppDatabase;

describe("history HTTP route", () => {
  beforeAll(async () => { database = await createApiTestDatabase(); });
  afterAll(async () => { await database.close(); });

  beforeEach(async () => {
    // 历史查询涉及订阅、地区商品和快照外键；统一清空一次性库保证各用例独立且不会残留价格数据。
    await resetApiTestData(database);
  });

  it("returns a subscription's immutable snapshots in capture order and filters by region", async () => {
    // 时间序列供曲线绘制使用，按 capturedAt 升序返回；地区筛选必须在服务端执行，不让前端下载其他区域的无关历史。
    const cookie = await login();
    await seedHistory();
    const all = await call("/api/history?subscriptionId=sub-1", cookie);
    expect(all.status).toBe(200);
    await expect(all.json()).resolves.toEqual({ snapshots: [
      { regionCode: "JP", amountMinor: 1000, currency: "JPY", cnyFen: 4200, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
      { regionCode: "US", amountMinor: 999, currency: "USD", cnyFen: 6800, source: "eshop-prices", capturedAt: "2026-07-16T00:00:00.000Z" },
    ] });
    const japan = await call("/api/history?subscriptionId=sub-1&region=JP", cookie);
    await expect(japan.json()).resolves.toEqual({ snapshots: [
      { regionCode: "JP", amountMinor: 1000, currency: "JPY", cnyFen: 4200, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
    ] });
  });

  it("exports price history as a CSV without authentication or Telegram fields", async () => {
    // CSV 只包含价格分析所需的公开业务字段，避免导出把管理员哈希、会话或未来 Telegram 秘密一并带走。
    const cookie = await login();
    await seedHistory();
    const response = await call("/api/export?kind=prices", cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    await expect(response.text()).resolves.toContain("region_code,amount_minor,currency,cny_fen,source,captured_at");
  });

  it("exports subscription configuration and fetch logs through separate field allowlists", async () => {
    // 三种导出用途不同；订阅配置和诊断日志也必须独立固定列，不能复用包含认证字段的任何管理查询。
    const cookie = await login();
    await seedHistory();
    await database.query("INSERT INTO fetch_logs (regional_product_id, source, status, message, captured_at) VALUES ($1, $2, $3, $4, $5)", ["jp-1", "official", "success", "价格已读取", "2026-07-16T00:00:00.000Z"]);
    const subscriptions = await call("/api/export?kind=subscriptions", cookie);
    const logs = await call("/api/export?kind=fetch-logs", cookie);

    await expect(subscriptions.text()).resolves.toContain("subscription_id,game_id,enabled,region_code,regional_product_id");
    await expect(logs.text()).resolves.toContain("region_code,source,status,message,captured_at");
  });
});

async function seedHistory(): Promise<void> {
  // 构造两区一次采集成功的最小历史；事务保证任一夹具写入失败时不会留下半条时间序列。
  await database.transaction(async (transaction) => {
    await transaction.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["g-1", "测试游戏", "Test Game", "game"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)", ["jp-1", "g-1", "JP", "JPY", "https://example.test/jp", "manual_selection"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)", ["us-1", "g-1", "US", "USD", "https://example.test/us", "manual_selection"]);
    await transaction.query("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", ["sub-1", "g-1", true, "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z"]);
    await transaction.query("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)", ["sub-1", "jp-1"]);
    await transaction.query("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)", ["sub-1", "us-1"]);
    await transaction.query("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6)", ["jp-1", 1000, "JPY", 4200, "official", "2026-07-15T00:00:00.000Z"]);
    await transaction.query("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6)", ["us-1", 999, "USD", 6800, "eshop-prices", "2026-07-16T00:00:00.000Z"]);
  });
}

async function login(): Promise<string> {
  return (await initializeAndLogin(database, { enabledRegions: ["US", "JP"], defaultSearchRegion: "US" })).cookie;
}
async function call(path: string, cookie: string): Promise<Response> {
  // null 表示 Node dispatcher 遗漏 API，不能静默落入静态前端。
  const response = await createTestNodeDispatcher(database)(jsonRequest(path, undefined, cookie, "GET"));
  if (!response) throw new Error("历史或导出测试请求未被 Node API 处理");
  return response;
}
