import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";

describe("subscription management HTTP routes", () => {
  beforeEach(async () => {
    // 订阅接口涉及认证、游戏与地区商品三类外键；按依赖倒序清理可避免前一轮数据让重复订阅断言失真。
    await env.DB.exec(
      "DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;",
    );
    await seedSubscriptionCandidate();
  });

  it("rejects subscription creation when the administrator session is absent", async () => {
    // 订阅会改变监控范围与后续通知，未登录请求不能仅依赖前端隐藏按钮，必须由 Worker 返回 401 拦截。
    const response = await call("/api/subscriptions", {
      id: "subscription-overcooked-2",
      gameId: "game-overcooked-2",
      regionalProductIds: ["product-overcooked-2-us"],
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: "UNAUTHORIZED", error: "请先登录。" });
  });

  it("creates one subscription for a game and reopens it instead of inserting a duplicate", async () => {
    // 同一游戏只能保留一个订阅，重复提交通常来自用户双击或刷新页面；返回既有 ID 能让前端安全跳转详情页。
    const cookie = await initializeAndLogin();
    const first = await call(
      "/api/subscriptions",
      {
        id: "subscription-overcooked-2",
        gameId: "game-overcooked-2",
        regionalProductIds: ["product-overcooked-2-us", "product-overcooked-2-jp"],
      },
      cookie,
    );
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", created: true });

    const repeated = await call(
      "/api/subscriptions",
      {
        id: "subscription-should-not-be-used",
        gameId: "game-overcooked-2",
        regionalProductIds: ["product-overcooked-2-us"],
      },
      cookie,
    );
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", created: false });

    // 直接检查持久化数量，证明“重复打开”没有暗中写入第二个订阅或覆盖用户先前确认的地区范围。
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions").first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_regions").first<{ count: number }>()).resolves.toEqual({ count: 2 });
  });

  it("rejects a regional product that belongs to a different game", async () => {
    // 地区商品是跨区匹配后的受控结果，但浏览器提交仍不可信；若混入另一款游戏会污染最低价与 Telegram 日报分组。
    const cookie = await initializeAndLogin();
    const response = await call(
      "/api/subscriptions",
      {
        id: "subscription-overcooked-2",
        gameId: "game-overcooked-2",
        regionalProductIds: ["product-unrelated-us"],
      },
      cookie,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "地区商品不属于所选游戏。" });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions").first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });

  it("soft-disables and re-enables a subscription without removing its regional configuration", async () => {
    // 取消订阅只应暂停采集与通知；地区选择和历史关联必须留下，重新启用时无需再次搜索、匹配商品。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);

    const disabled = await call("/api/subscriptions/subscription-overcooked-2/disable", undefined, cookie);
    expect(disabled.status).toBe(204);
    await expect(env.DB.prepare("SELECT enabled AS enabled FROM subscriptions WHERE id = ?").bind("subscription-overcooked-2").first<{ enabled: number }>()).resolves.toEqual({ enabled: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_regions").first<{ count: number }>()).resolves.toEqual({ count: 2 });

    const reenabled = await call("/api/subscriptions/subscription-overcooked-2", { enabled: true }, cookie, "PATCH");
    expect(reenabled.status).toBe(200);
    await expect(reenabled.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", enabled: true });
    await expect(env.DB.prepare("SELECT enabled AS enabled FROM subscriptions WHERE id = ?").bind("subscription-overcooked-2").first<{ enabled: number }>()).resolves.toEqual({ enabled: 1 });
  });

  it("saves a global CNY target and a regional local-currency target for a subscription", async () => {
    // 单区目标价格优先于全局人民币目标；两者都以最小货币单位保存，避免浮点金额让提醒阈值出现偏差。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);
    const response = await call(
      "/api/subscriptions/subscription-overcooked-2",
      { globalTargetCnyFen: 5000, regionTargets: [{ regionCode: "JP", targetAmountMinor: 800 }] },
      cookie,
      "PATCH",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", globalTargetCnyFen: 5000, regionTargets: [{ regionCode: "JP", targetAmountMinor: 800 }] });
    await expect(env.DB.prepare("SELECT global_target_cny_fen AS target FROM subscriptions WHERE id = ?").bind("subscription-overcooked-2").first<{ target: number }>()).resolves.toEqual({ target: 5000 });
    await expect(env.DB.prepare("SELECT target_amount_minor AS target FROM subscription_region_targets WHERE subscription_id = ? AND region_code = ?").bind("subscription-overcooked-2", "JP").first<{ target: number }>()).resolves.toEqual({ target: 800 });
  });
});

async function seedSubscriptionCandidate(): Promise<void> {
  // 候选游戏与两个地区商品模拟搜索、匹配完成后的状态；接口只接受已确认的商品 ID，不能替用户猜测商品。
  await env.DB.batch([
    env.DB
      .prepare("INSERT INTO games (id, name_zh, name_en, product_type, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game", "2026-07-16T00:00:00.000Z"),
    env.DB
      .prepare("INSERT INTO games (id, name_zh, name_en, product_type, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("game-unrelated", "无关游戏", "Unrelated Game", "game", "2026-07-16T00:00:00.000Z"),
    env.DB
      .prepare(
        "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "product-overcooked-2-us",
        "game-overcooked-2",
        "US",
        "USD",
        "https://example.test/us/overcooked-2",
        "manual_selection",
        1,
        "2026-07-16T00:00:00.000Z",
      ),
    env.DB
      .prepare(
        "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "product-overcooked-2-jp",
        "game-overcooked-2",
        "JP",
        "JPY",
        "https://example.test/jp/overcooked-2",
        "manual_selection",
        1,
        "2026-07-16T00:00:00.000Z",
      ),
    env.DB
      .prepare(
        "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "product-unrelated-us",
        "game-unrelated",
        "US",
        "USD",
        "https://example.test/us/unrelated-game",
        "manual_selection",
        1,
        "2026-07-16T00:00:00.000Z",
      ),
  ]);
}

async function initializeAndLogin(): Promise<string> {
  // 通过真实 HTTP 初始化与登录建立 HttpOnly 会话，避免在测试中伪造令牌而漏测路由守卫。
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

async function createSubscription(cookie: string): Promise<void> {
  // 公共夹具从真实创建端点建立初始状态，保证停用测试也覆盖受保护写入的完整调用链。
  const response = await call(
    "/api/subscriptions",
    {
      id: "subscription-overcooked-2",
      gameId: "game-overcooked-2",
      regionalProductIds: ["product-overcooked-2-us", "product-overcooked-2-jp"],
    },
    cookie,
  );
  expect(response.status).toBe(201);
}

async function call(path: string, body?: unknown, cookie?: string, method = "POST"): Promise<Response> {
  // 订阅管理是 JSON API，测试资源绑定若被调用就会报错，确保请求没有意外落到静态前端层。
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
