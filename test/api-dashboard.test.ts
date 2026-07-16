import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";

describe("dashboard HTTP route", () => {
  beforeEach(async () => {
    // 仪表盘从订阅与价格历史派生；清理全部相关表确保空状态的返回不受其他 API 测试留下的快照影响。
    await env.DB.exec("DELETE FROM price_snapshots; DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
  });

  it("returns an authenticated empty subscription overview before any game is added", async () => {
    // 空仪表盘是首次初始化后的正常状态，必须返回稳定数组而不是把没有订阅误报成服务器错误。
    const cookie = await initializeAndLogin();
    const response = await call("/api/dashboard", cookie);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ subscriptions: [] });
  });

  it("lists an existing subscription with its game identity and selected regional products", async () => {
    // 即使尚未采集到价格，管理员也必须在仪表盘看到已创建订阅，才能判断系统正在等待首次采集而非丢失配置。
    const cookie = await initializeAndLogin();
    await seedSubscription();
    const response = await call("/api/dashboard", cookie);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      subscriptions: [
        {
          subscriptionId: "subscription-overcooked-2",
          gameId: "game-overcooked-2",
          nameZh: "胡闹厨房 2",
          nameEn: "Overcooked! 2",
          enabled: true,
          regionalProductIds: ["product-overcooked-2-us"],
          regions: [
            {
              regionalProductId: "product-overcooked-2-us",
              regionCode: "US",
              currency: "USD",
              current: null,
              historicalLow: null,
            },
          ],
        },
      ],
    });
  });

  it("returns the latest snapshot and the regional historical low without treating a third-party result as official", async () => {
    // 当前价按最新采集时间选择，历史最低价按本币最小金额选择；来源字段必须原样返回，让前端清楚标记第三方数据。
    const cookie = await initializeAndLogin();
    await seedSubscription();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-overcooked-2-us", 999, "USD", 6800, "official", "2026-07-15T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-overcooked-2-us", 1099, "USD", 7450, "eshop-prices", "2026-07-16T00:00:00.000Z"),
    ]);
    const response = await call("/api/dashboard", cookie);
    const body = await response.json<{ subscriptions: Array<{ regions: Array<{ current: unknown; historicalLow: unknown }> }> }>();

    expect(response.status).toBe(200);
    expect(body.subscriptions[0].regions[0]).toEqual({
      regionalProductId: "product-overcooked-2-us",
      regionCode: "US",
      currency: "USD",
      current: { amountMinor: 1099, cnyFen: 7450, source: "eshop-prices", capturedAt: "2026-07-16T00:00:00.000Z" },
      historicalLow: { amountMinor: 999, cnyFen: 6800, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
    });
  });
});

async function seedSubscription(): Promise<void> {
  // 直接构造已完成匹配和订阅确认的数据状态，隔离仪表盘读取语义，不让本测试依赖商品发现接口的未来实现。
  await env.DB.batch([
    env.DB.prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)").bind("game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game"),
    env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)").bind("product-overcooked-2-us", "game-overcooked-2", "US", "USD", "https://example.test/us", "manual_selection"),
    env.DB.prepare("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind("subscription-overcooked-2", "game-overcooked-2", 1, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind("subscription-overcooked-2", "product-overcooked-2-us"),
  ]);
}

async function initializeAndLogin(): Promise<string> {
  // 使用真实认证路由取得会话，确保仪表盘与所有管理页面共享同一 Cookie 安全边界。
  const initialized = await request("/api/auth/initialize", { password: "correct-horse-battery-staple", enabledRegions: ["US"], defaultSearchRegion: "US" });
  expect(initialized.status).toBe(201);
  const login = await request("/api/auth/login", { password: "correct-horse-battery-staple" });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie") ?? "";
}

async function call(path: string, cookie: string): Promise<Response> {
  // 资源绑定被命中表示 Worker 漏注册了仪表盘 API；测试以 500 让该问题不可被静默忽略。
  const assets = { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher;
  return worker.fetch!(new Request(`https://example.test${path}`, { headers: { cookie } }) as never, { DB: env.DB, ASSETS: assets } as Env, {} as ExecutionContext);
}

async function request(path: string, body: unknown): Promise<Response> {
  const assets = { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher;
  return worker.fetch!(new Request(`https://example.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never, { DB: env.DB, ASSETS: assets } as Env, {} as ExecutionContext);
}
