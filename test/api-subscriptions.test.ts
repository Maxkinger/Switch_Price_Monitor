import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase } from "../src/server/database/types";
import { createApiTestDatabase, createTestNodeDispatcher, initializeAndLogin as initializeAdmin, jsonRequest, resetApiTestData } from "./support/api-postgres";

// 订阅路由、持久化断言与夹具共用一次性 PostgreSQL；文件串行运行并在结束时关闭连接池。
let database: AppDatabase;

describe("subscription management HTTP routes", () => {
  beforeAll(async () => { database = await createApiTestDatabase(); });
  afterAll(async () => { await database.close(); });

  beforeEach(async () => {
    // 硬删除覆盖快照、日志、健康状态、通知和目标价；清空一次性库避免某次删除测试污染后续用例。
    await resetApiTestData(database);
    await seedSubscriptionCandidate();
  });

  it("creates a subscription without a cookie during local development", async () => {
    // 当前开发期特意移除会话门槛；仍须验证真实写入成功，防止守卫放行后路由遗漏服务调用。
    const response = await call("/api/subscriptions", {
      id: "subscription-overcooked-2",
      gameId: "game-overcooked-2",
      regionalProductIds: ["product-overcooked-2-us"],
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", created: true });
  });

  it("performs hard deletion without a cookie during local development", async () => {
    // 开发期直接访问不替代精确 ID 和事务约束；先创建再删除可证明无 Cookie 路径未绕开真实服务。
    await call("/api/subscriptions", { id: "subscription-overcooked-2", gameId: "game-overcooked-2", regionalProductIds: ["product-overcooked-2-us"] });
    const response = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2"] }, undefined, "DELETE");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deletedSubscriptionIds: ["subscription-overcooked-2"] });
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
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscriptions")).resolves.toEqual({ count: 1 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscription_regions")).resolves.toEqual({ count: 2 });
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
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscriptions")).resolves.toEqual({ count: 0 });
  });

  it("soft-disables and re-enables a subscription without removing its regional configuration", async () => {
    // 取消订阅只应暂停采集与通知；地区选择和历史关联必须留下，重新启用时无需再次搜索、匹配商品。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);

    const disabled = await call("/api/subscriptions/subscription-overcooked-2/disable", undefined, cookie);
    expect(disabled.status).toBe(204);
    await expect(queryOne<{ enabled: boolean }>("SELECT enabled FROM subscriptions WHERE id = $1", ["subscription-overcooked-2"])).resolves.toEqual({ enabled: false });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscription_regions")).resolves.toEqual({ count: 2 });

    const reenabled = await call("/api/subscriptions/subscription-overcooked-2", { enabled: true }, cookie, "PATCH");
    expect(reenabled.status).toBe(200);
    await expect(reenabled.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", enabled: true });
    await expect(queryOne<{ enabled: boolean }>("SELECT enabled FROM subscriptions WHERE id = $1", ["subscription-overcooked-2"])).resolves.toEqual({ enabled: true });
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
    await expect(queryOne<{ target: number }>("SELECT global_target_cny_fen AS target FROM subscriptions WHERE id = $1", ["subscription-overcooked-2"])).resolves.toEqual({ target: 5000 });
    await expect(queryOne<{ target: number }>("SELECT target_amount_minor AS target FROM subscription_region_targets WHERE subscription_id = $1 AND region_code = $2", ["subscription-overcooked-2", "JP"])).resolves.toEqual({ target: 800 });
  });

  it("replaces a subscription's monitored regional products without creating another subscription", async () => {
    // 地区编辑应替换监控范围而非新增订阅；旧价格历史仍保留在地区商品上，只有未来采集范围发生变化。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);
    const response = await call("/api/subscriptions/subscription-overcooked-2", { regionalProductIds: ["product-overcooked-2-jp"] }, cookie, "PATCH");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", regionalProductIds: ["product-overcooked-2-jp"] });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscription_regions WHERE subscription_id = $1", ["subscription-overcooked-2"])).resolves.toEqual({ count: 1 });
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
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM fetch_logs WHERE regional_product_id IS NOT NULL OR source = $1", ["official-test"])).resolves.toEqual({ count: 0 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM price_snapshots")).resolves.toEqual({ count: 0 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM regional_product_health")).resolves.toEqual({ count: 0 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM notification_events")).resolves.toEqual({ count: 0 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscription_region_targets")).resolves.toEqual({ count: 0 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscription_regions WHERE subscription_id = $1", ["subscription-overcooked-2"])).resolves.toEqual({ count: 0 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscriptions")).resolves.toEqual({ count: 1 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM regional_products WHERE game_id = $1", ["game-overcooked-2"])).resolves.toEqual({ count: 0 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM games WHERE id = $1", ["game-overcooked-2"])).resolves.toEqual({ count: 0 });
    // 未选中的订阅、游戏及全局汇率不属于目标订阅专属数据，删除一个订阅绝不能清理它们。
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscriptions WHERE id = $1", ["subscription-unrelated"])).resolves.toEqual({ count: 1 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM games WHERE id = $1", ["game-unrelated"])).resolves.toEqual({ count: 1 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM exchange_rates WHERE currency = $1", ["USD"])).resolves.toEqual({ count: 1 });
  });

  it("does not delete any selected subscription when one requested identifier is absent", async () => {
    // 全部 ID 必须先通过存在性验证；若批量选择包含已被其他标签页删除的订阅，不能部分删除其余用户数据。
    const cookie = await initializeAndLogin();
    await createSubscription(cookie);
    await seedSubscriptionDependentData();

    const response = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2", "subscription-missing"] }, cookie, "DELETE");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "NOT_FOUND", error: "订阅不存在。" });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscriptions WHERE id = $1", ["subscription-overcooked-2"])).resolves.toEqual({ count: 1 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM price_snapshots")).resolves.toEqual({ count: 1 });
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM games WHERE id = $1", ["game-overcooked-2"])).resolves.toEqual({ count: 1 });
  });

  it("rejects empty or duplicated hard-delete selections before querying PostgreSQL", async () => {
    // 空选与重复选常来自过期页面状态；路由必须在服务层之前拒绝，避免重复占位符或含糊的删除结果。
    const cookie = await initializeAndLogin();
    const empty = await call("/api/subscriptions", { subscriptionIds: [] }, cookie, "DELETE");
    const duplicated = await call("/api/subscriptions", { subscriptionIds: ["subscription-overcooked-2", "subscription-overcooked-2"] }, cookie, "DELETE");

    expect(empty.status).toBe(422);
    expect(duplicated.status).toBe(422);
    await expect(queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM games WHERE id = $1", ["game-overcooked-2"])).resolves.toEqual({ count: 1 });
  });
});

/** 构造订阅专属的所有关联记录；全局汇率故意独立插入，供硬删除测试确认其不会被误删。 */
async function seedSubscriptionDependentData(): Promise<void> {
  // 所有专属数据在一个夹具事务中写入；任一约束失败都不能留下会让硬删除断言失真的半成品。
  await database.transaction(async (transaction) => {
    await transaction.query("INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES ($1, $2, $3, $4)", ["subscription-overcooked-2", "JP", 800, "met"]);
    await transaction.query("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6)", ["product-overcooked-2-jp", 800, "JPY", 4000, "official", "2026-07-18T00:00:00.000Z"]);
    await transaction.query("INSERT INTO fetch_logs (regional_product_id, source, status, message, captured_at) VALUES ($1, $2, $3, $4, $5)", ["product-overcooked-2-jp", "official-test", "failed", "测试采集失败", "2026-07-18T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at) VALUES ($1, $2, $3, $4, $5)", ["product-overcooked-2-jp", 3, null, true, "2026-07-18T00:00:00.000Z"]);
    await transaction.query("INSERT INTO notification_events (subscription_id, regional_product_id, event_type, status, dedupe_key, created_at) VALUES ($1, $2, $3, $4, $5, $6)", ["subscription-overcooked-2", "product-overcooked-2-jp", "official-price-drop", "pending", "delete-test-event", "2026-07-18T00:00:00.000Z"]);
    await transaction.query("INSERT INTO exchange_rates (currency, cny_rate, source, captured_at, is_stale) VALUES ($1, $2, $3, $4, $5)", ["USD", 7.2, "test", "2026-07-18T00:00:00.000Z", false]);
  });
}

async function seedSubscriptionCandidate(): Promise<void> {
  // 候选游戏与两个地区商品模拟搜索、匹配完成后的状态；接口只接受已确认的商品 ID，不能替用户猜测商品。
  await database.transaction(async (transaction) => {
    await transaction.query("INSERT INTO games (id, name_zh, name_en, product_type, created_at) VALUES ($1, $2, $3, $4, $5)", ["game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game", "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO games (id, name_zh, name_en, product_type, created_at) VALUES ($1, $2, $3, $4, $5)", ["game-unrelated", "无关游戏", "Unrelated Game", "game", "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", ["product-overcooked-2-us", "game-overcooked-2", "US", "USD", "https://example.test/us/overcooked-2", "manual_selection", true, "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", ["product-overcooked-2-jp", "game-overcooked-2", "JP", "JPY", "https://example.test/jp/overcooked-2", "manual_selection", true, "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", ["product-unrelated-us", "game-unrelated", "US", "USD", "https://example.test/us/unrelated-game", "manual_selection", true, "2026-07-16T00:00:00.000Z"]);
  });
}

async function initializeAndLogin(): Promise<string> {
  // 通过真实 PostgreSQL 初始化与登录建立 HttpOnly 会话，避免伪造令牌而漏测路由守卫。
  return (await initializeAdmin(database, { enabledRegions: ["US", "JP"], defaultSearchRegion: "US" })).cookie;
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
  // 真实 Node dispatcher 必须消费订阅 API；null 会立即暴露路由遗漏而不是静默落入前端。
  const response = await createTestNodeDispatcher(database)(jsonRequest(path, body, cookie, method));
  if (!response) throw new Error("订阅管理测试请求未被 Node API 处理");
  return response;
}

/** PostgreSQL 查询只返回首行；动态值始终通过参数数组绑定，测试不会拼接订阅 ID 或来源。 */
async function queryOne<Row>(sql: string, parameters: readonly unknown[] = []): Promise<Row | null> {
  return (await database.query<Row>(sql, parameters)).rows[0] ?? null;
}
