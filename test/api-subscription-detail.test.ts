import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";

/**
 * 订阅详情读取接口测试覆盖三项管理员可见的业务事实：详情仅对已登录会话开放、
 * 已确认但暂未监控的地区仍须展示以便安全编辑，以及价格快照/失败健康状态不能被前端猜测。
 */
describe("subscription detail HTTP route", () => {
  beforeEach(async () => {
    // 详情依赖价格、目标价、订阅、地区商品与认证记录；按外键依赖倒序清理，避免测试轮次互相保留状态。
    await env.DB.exec(
      "DELETE FROM price_snapshots; DELETE FROM subscription_region_targets; DELETE FROM regional_product_health; DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;",
    );
    await seedSubscriptionDetail();
  });

  it("returns a subscribed game's confirmed regions, targets, current price and historical low", async () => {
    // 真实初始化和登录路径生成 HttpOnly 会话，防止测试绕过认证守卫而只验证了数据库读取本身。
    const cookie = await initializeAndLogin();
    const response = await call("/api/subscriptions/subscription-overcooked-2", undefined, cookie, "GET");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      subscriptionId: "subscription-overcooked-2",
      game: {
        id: "game-overcooked-2",
        nameZh: "胡闹厨房 2",
        nameEn: "Overcooked! 2",
        productType: "game",
      },
      enabled: true,
      globalTargetCnyFen: 5000,
      regionTargets: [{ regionCode: "JP", targetAmountMinor: 800 }],
      regions: [
        {
          regionalProductId: "product-overcooked-2-us",
          regionCode: "US",
          currency: "USD",
          monitored: true,
          current: {
            amountMinor: 1099,
            cnyFen: 7450,
            source: "official",
            capturedAt: "2026-07-17T00:00:00.000Z",
          },
          historicalLow: {
            amountMinor: 999,
            cnyFen: 6800,
            source: "official",
            capturedAt: "2026-07-16T00:00:00.000Z",
          },
          isStale: true,
        },
        {
          // 日区商品已经在官方确认流程中建立，但尚未被订阅选中；详情仍要返回它，前端才能只选用受控商品 ID 编辑地区。
          regionalProductId: "product-overcooked-2-jp",
          regionCode: "JP",
          currency: "JPY",
          monitored: false,
          current: null,
          historicalLow: null,
          isStale: false,
        },
      ],
    });
  });

  it("does not expose subscription detail without a session and returns 404 for an unknown id", async () => {
    // 会话校验必须发生在数据读取之前，匿名调用不应借 404/200 差异枚举订阅存在性或读取价格轨迹。
    const anonymous = await call("/api/subscriptions/subscription-overcooked-2", undefined, "", "GET");
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toEqual({ code: "UNAUTHORIZED", error: "请先登录。" });

    const cookie = await initializeAndLogin();
    const missing = await call("/api/subscriptions/missing", undefined, cookie, "GET");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ code: "NOT_FOUND", error: "订阅不存在。" });
  });
});

async function seedSubscriptionDetail(): Promise<void> {
  // 夹具明确覆盖一个已监控、有快照且采集失败的美区，以及一个已确认但未监控、从未采集的日区。
  // 这能验证详情页的编辑边界不会要求浏览器再次发现或伪造地区商品标识。
  await env.DB.batch([
    env.DB.prepare("INSERT INTO games (id, name_zh, name_en, product_type, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game", "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("product-overcooked-2-us", "game-overcooked-2", "US", "USD", "https://example.test/us/overcooked-2", "manual_selection", 1, "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("product-overcooked-2-jp", "game-overcooked-2", "JP", "JPY", "https://example.test/jp/overcooked-2", "manual_selection", 1, "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO subscriptions (id, game_id, enabled, global_target_cny_fen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("subscription-overcooked-2", "game-overcooked-2", 1, 5000, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
      .bind("subscription-overcooked-2", "product-overcooked-2-us"),
    env.DB.prepare("INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES (?, ?, ?, ?)")
      .bind("subscription-overcooked-2", "JP", 800, "unmet"),
    env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("product-overcooked-2-us", 999, "USD", 6800, "official", "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("product-overcooked-2-us", 1099, "USD", 7450, "official", "2026-07-17T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind("product-overcooked-2-us", 1, "2026-07-16T00:00:00.000Z", 0, "2026-07-17T00:00:00.000Z"),
  ]);
}

async function initializeAndLogin(): Promise<string> {
  // 密码仅是测试夹具值，真实系统只以哈希保存；通过接口建立会话可同时验证 Cookie 的安全路径。
  const initialized = await call("/api/auth/initialize", {
    password: "correct-horse-battery-staple",
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
  });
  expect(initialized.status).toBe(201);

  const login = await call("/api/auth/login", { password: "correct-horse-battery-staple" });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie") ?? "";
}

async function call(path: string, body?: unknown, cookie?: string, method = "POST"): Promise<Response> {
  // 详情是 JSON API；静态资源桩若被调用即返回 500，用于证明路由没有错误落入前端静态资源层。
  const assets = { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher;
  return worker.fetch!(
    new Request(`https://example.test${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    }) as never,
    { DB: env.DB, ASSETS: assets } as Env,
    {} as ExecutionContext,
  );
}
