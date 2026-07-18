import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";

describe("subscription management HTTP routes", () => {
  beforeEach(async () => {
    // 硬删除覆盖快照、日志、健康状态、通知和目标价；夹具必须先按依赖倒序清理，避免某次删除测试的外键数据污染后续用例。
    await env.DB.exec(
      "DELETE FROM notification_events; DELETE FROM regional_product_health; DELETE FROM fetch_logs; DELETE FROM price_snapshots; DELETE FROM subscription_region_targets; DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM exchange_rates; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;",
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

  it("rejects hard deletion when the administrator session is absent", async () => {
    // 永久删除会清除价格与通知审计记录，必须和创建一样由 HttpOnly 管理员会话保护，不能仅依赖前端确认框。
    const response = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2"] }, undefined, "DELETE");

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

  it("replaces a subscription's monitored regional products without creating another subscription", async () => {
    // 地区编辑应替换监控范围而非新增订阅；旧价格历史仍保留在地区商品上，只有未来采集范围发生变化。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);
    const response = await call("/api/subscriptions/subscription-overcooked-2", { regionalProductIds: ["product-overcooked-2-jp"] }, cookie, "PATCH");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", regionalProductIds: ["product-overcooked-2-jp"] });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_regions WHERE subscription_id = ?").bind("subscription-overcooked-2").first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });

  it("atomically hard deletes a selected subscription and all of its exclusive price data", async () => {
    // 先通过真实创建路由建立订阅，再补齐所有受订阅或地区商品约束的数据，确保测试覆盖硬删除而不是软停用。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);
    await createUnrelatedSubscription(cookie);
    await seedSubscriptionDependentData();

    const response = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2"] }, cookie, "DELETE");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deletedSubscriptionIds: ["subscription-overcooked-2"] });
    // fetch_logs 的外键本可 SET NULL，但永久删除的业务语义要求也擦除这类诊断记录，避免无归属日志长期占用存储。
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM fetch_logs WHERE regional_product_id IS NOT NULL OR source = ?").bind("official-test").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM price_snapshots").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM regional_product_health").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM notification_events").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_region_targets").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_regions WHERE subscription_id = ?").bind("subscription-overcooked-2").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions").first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM regional_products WHERE game_id = ?").bind("game-overcooked-2").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM games WHERE id = ?").bind("game-overcooked-2").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    // 未选中的订阅、游戏及全局汇率不属于目标订阅专属数据，删除一个订阅绝不能清理它们。
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE id = ?").bind("subscription-unrelated").first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM games WHERE id = ?").bind("game-unrelated").first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM exchange_rates WHERE currency = ?").bind("USD").first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });

  it("does not delete any selected subscription when one requested identifier is absent", async () => {
    // 全部 ID 必须先通过存在性验证；若批量选择包含已被其他标签页删除的订阅，不能部分删除其余用户数据。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);
    await seedSubscriptionDependentData();

    const response = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2", "subscription-missing"] }, cookie, "DELETE");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND", error: "订阅不存在。" });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE id = ?").bind("subscription-overcooked-2").first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM price_snapshots").first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM games WHERE id = ?").bind("game-overcooked-2").first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });

  it("rejects empty or duplicated hard-delete selections before querying D1", async () => {
    // 空选与重复选常来自过期页面状态；路由必须在服务层之前拒绝，避免重复占位符或含糊的删除结果。
    const cookie = await initializeAndLogin();
    const empty = await call("/api/subscriptions", { subscriptionIds: [] }, cookie, "DELETE");
    const duplicated = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2", "subscription-overcooked-2"] }, cookie, "DELETE");

    expect(empty.status).toBe(422);
    expect(duplicated.status).toBe(422);
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM games WHERE id = ?").bind("game-overcooked-2").first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });
});

/** 构造订阅专属的所有关联记录；全局汇率故意独立插入，供硬删除测试确认其不会被误删。 */
async function seedSubscriptionDependentData(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES (?, ?, ?, ?)").bind("subscription-overcooked-2", "JP", 800, "met"),
    env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-overcooked-2-jp", 800, "JPY", 4000, "official", "2026-07-18T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO fetch_logs (regional_product_id, source, status, message, captured_at) VALUES (?, ?, ?, ?, ?)").bind("product-overcooked-2-jp", "official-test", "failed", "测试采集失败", "2026-07-18T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at) VALUES (?, ?, ?, ?, ?)").bind("product-overcooked-2-jp", 3, null, 1, "2026-07-18T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO notification_events (subscription_id, regional_product_id, event_type, status, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind("subscription-overcooked-2", "product-overcooked-2-jp", "price-drop", "pending", "delete-test-event", "2026-07-18T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO exchange_rates (currency, cny_rate, source, captured_at, is_stale) VALUES (?, ?, ?, ?, ?)").bind("USD", 7.2, "test", "2026-07-18T00:00:00.000Z", 0),
  ]);
}

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

/** 第二个真实订阅模拟仪表盘中的未选卡片，用于证明批量硬删除不会越过管理员明确选择的 ID 边界。 */
async function createUnrelatedSubscription(cookie: string): Promise<void> {
  const response = await call(
    "/api/subscriptions",
    {
      id: "subscription-unrelated",
      gameId: "game-unrelated",
      regionalProductIds: ["product-unrelated-us"],
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
