import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";

describe("history HTTP route", () => {
  beforeEach(async () => {
    // 历史查询涉及订阅、地区商品和快照外键；清理顺序保证各用例独立且不会残留价格数据。
    await env.DB.exec("DELETE FROM price_snapshots; DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
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
    await env.DB.prepare("INSERT INTO fetch_logs (regional_product_id,source,status,message,captured_at) VALUES (?,?,?,?,?)").bind("jp-1", "official", "success", "价格已读取", "2026-07-16T00:00:00.000Z").run();
    const subscriptions = await call("/api/export?kind=subscriptions", cookie);
    const logs = await call("/api/export?kind=fetch-logs", cookie);

    await expect(subscriptions.text()).resolves.toContain("subscription_id,game_id,enabled,region_code,regional_product_id");
    await expect(logs.text()).resolves.toContain("region_code,source,status,message,captured_at");
  });
});

async function seedHistory(): Promise<void> {
  // 构造两区一次采集成功的最小历史，来源字段不同以确认接口不会丢失官方/第三方标记。
  await env.DB.batch([
    env.DB.prepare("INSERT INTO games (id,name_zh,name_en,product_type) VALUES (?,?,?,?)").bind("g-1", "测试游戏", "Test Game", "game"),
    env.DB.prepare("INSERT INTO regional_products (id,game_id,region_code,currency,product_url,match_source) VALUES (?,?,?,?,?,?)").bind("jp-1", "g-1", "JP", "JPY", "https://example.test/jp", "manual_selection"),
    env.DB.prepare("INSERT INTO regional_products (id,game_id,region_code,currency,product_url,match_source) VALUES (?,?,?,?,?,?)").bind("us-1", "g-1", "US", "USD", "https://example.test/us", "manual_selection"),
    env.DB.prepare("INSERT INTO subscriptions (id,game_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?)").bind("sub-1", "g-1", 1, "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id,regional_product_id) VALUES (?,?)").bind("sub-1", "jp-1"),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id,regional_product_id) VALUES (?,?)").bind("sub-1", "us-1"),
    env.DB.prepare("INSERT INTO price_snapshots (regional_product_id,amount_minor,currency,cny_fen,source,captured_at) VALUES (?,?,?,?,?,?)").bind("jp-1", 1000, "JPY", 4200, "official", "2026-07-15T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO price_snapshots (regional_product_id,amount_minor,currency,cny_fen,source,captured_at) VALUES (?,?,?,?,?,?)").bind("us-1", 999, "USD", 6800, "eshop-prices", "2026-07-16T00:00:00.000Z"),
  ]);
}

async function login(): Promise<string> {
  const init = await request("/api/auth/initialize", { password: "correct-horse-battery-staple", enabledRegions: ["US", "JP"], defaultSearchRegion: "US" }); expect(init.status).toBe(201);
  const result = await request("/api/auth/login", { password: "correct-horse-battery-staple" }); return result.headers.get("set-cookie") ?? "";
}
async function call(path: string, cookie: string): Promise<Response> { return invoke(new Request(`https://example.test${path}`, { headers: { cookie } })); }
async function request(path: string, body: unknown): Promise<Response> { return invoke(new Request(`https://example.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })); }
async function invoke(request: Request): Promise<Response> {
  // 静态资源命中说明 API 尚未注册；统一构造 Worker 上下文避免辅助函数遗漏真实 D1 绑定。
  return worker.fetch!(request as never, { DB: env.DB, ASSETS: { fetch: async () => new Response("unexpected", { status: 500 }) } as unknown as Fetcher } as Env, {} as ExecutionContext) as Promise<Response>;
}
