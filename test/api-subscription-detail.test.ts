import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleSubscriptionRoute } from "../src/routes/subscription-routes";
import type { RegionResolution } from "../src/services/official-product-discovery-service";
import type { CompletionRegionsInput, CompletionRegionsResult } from "../src/services/subscription-region-completion-service";
import { PostgresSubscriptionRepository } from "../src/repositories/postgres/subscription-repository";
import { PostgresSubscriptionDetailRepository } from "../src/repositories/postgres/subscription-detail-repository";
import type { AppDatabase } from "../src/server/database/types";
import { SubscriptionService } from "../src/services/subscription-service";
import { SubscriptionDetailService } from "../src/services/subscription-detail-service";
import { createApiTestDatabase, createTestAuth, createTestNodeDispatcher, initializeAndLogin as initializeAdmin, jsonRequest, resetApiTestData } from "./support/api-postgres";

// 详情查询、会话守卫和补全路由共用一次性 PostgreSQL；补全外部发现依赖始终由当前文件的受控 fake 替代。
let database: AppDatabase;

/**
 * 订阅详情读取接口测试覆盖三项管理员可见的业务事实：详情仅对已登录会话开放、
 * 已确认但暂未监控的地区仍须展示以便安全编辑，以及价格快照/失败健康状态不能被前端猜测。
 */
describe("subscription detail HTTP route", () => {
  beforeAll(async () => { database = await createApiTestDatabase(); });
  afterAll(async () => { await database.close(); });

  beforeEach(async () => {
    // 详情依赖价格、目标价、订阅、地区商品与认证记录；统一清空一次性库避免测试轮次互相保留状态。
    await resetApiTestData(database);
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

  it("routes region completion through the authenticated server service without accepting a browser region scope", async () => {
    const cookie = await initializeAndLogin();
    const calls: string[] = [];
    const completion = {
      resolveExisting: async (subscriptionId: string) => {
        calls.push(`resolve:${subscriptionId}`);
        return [{ candidateKey: "US:official", regionCode: "JP" as const, status: "needs-manual-link" as const }];
      },
      completeExisting: async (subscriptionId: string, input: { regions: unknown[]; skippedRegionCodes: string[] }) => {
        calls.push(`complete:${subscriptionId}:${input.regions.length}:${input.skippedRegionCodes.join(",")}`);
        return { subscriptionId, addedRegionCodes: [] };
      },
    };

    // 解析请求故意附带旧版浏览器地区数组；新端点不读取该字段，范围必须由 Node 服务端保存设置决定。
    const resolved = await callCompletionRoute("/api/subscriptions/subscription-overcooked-2/resolve-regions", { enabledRegions: ["HK"] }, cookie, completion);
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toEqual([{ candidateKey: "US:official", regionCode: "JP", status: "needs-manual-link" }]);

    const completed = await callCompletionRoute("/api/subscriptions/subscription-overcooked-2/complete-regions", { regions: [], skippedRegionCodes: ["JP"] }, cookie, completion);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({ subscriptionId: "subscription-overcooked-2", addedRegionCodes: [] });
    expect(calls).toEqual(["resolve:subscription-overcooked-2", "complete:subscription-overcooked-2:0:JP"]);
  });
});

async function seedSubscriptionDetail(): Promise<void> {
  // 夹具明确覆盖一个已监控、有快照且采集失败的美区，以及一个已确认但未监控、从未采集的日区。
  // 这能验证详情页的编辑边界不会要求浏览器再次发现或伪造地区商品标识。
  await database.transaction(async (transaction) => {
    await transaction.query("INSERT INTO games (id, name_zh, name_en, product_type, created_at) VALUES ($1, $2, $3, $4, $5)", ["game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game", "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", ["product-overcooked-2-us", "game-overcooked-2", "US", "USD", "https://example.test/us/overcooked-2", "manual_selection", true, "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", ["product-overcooked-2-jp", "game-overcooked-2", "JP", "JPY", "https://example.test/jp/overcooked-2", "manual_selection", true, "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO subscriptions (id, game_id, enabled, global_target_cny_fen, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", ["subscription-overcooked-2", "game-overcooked-2", true, 5000, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)", ["subscription-overcooked-2", "product-overcooked-2-us"]);
    await transaction.query("INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES ($1, $2, $3, $4)", ["subscription-overcooked-2", "JP", 800, "unmet"]);
    await transaction.query("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6)", ["product-overcooked-2-us", 999, "USD", 6800, "official", "2026-07-16T00:00:00.000Z"]);
    await transaction.query("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6)", ["product-overcooked-2-us", 1099, "USD", 7450, "official", "2026-07-17T00:00:00.000Z"]);
    await transaction.query("INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at) VALUES ($1, $2, $3, $4, $5)", ["product-overcooked-2-us", 1, "2026-07-16T00:00:00.000Z", false, "2026-07-17T00:00:00.000Z"]);
  });
}

async function initializeAndLogin(): Promise<string> {
  // 密码仅是测试夹具值，PostgreSQL 只保存派生哈希；通过接口建立会话可同时验证 Cookie 安全路径。
  return (await initializeAdmin(database, { enabledRegions: ["US", "JP"], defaultSearchRegion: "US" })).cookie;
}

async function call(path: string, body?: unknown, cookie?: string, method = "POST"): Promise<Response> {
  // 详情是 JSON API；真实 Node dispatcher 返回 null 即视为路由遗漏，不能落入前端静态层。
  const response = await createTestNodeDispatcher(database)(jsonRequest(path, body, cookie, method));
  if (!response) throw new Error("订阅详情测试请求未被 Node API 处理");
  return response;
}

/**
 * 直接调用订阅路由以替换真实任天堂网络依赖，同时保留真实 PostgreSQL 会话守卫。
 * 该夹具验证路由仅传递受控补全载荷，跨区范围仍由注入的 Node 服务决定，浏览器字段不得影响它。
 */
async function callCompletionRoute(
  path: string,
  body: unknown,
  cookie: string,
  completion: {
    resolveExisting(subscriptionId: string): Promise<RegionResolution[]>;
    completeExisting(subscriptionId: string, input: CompletionRegionsInput, now: string): Promise<CompletionRegionsResult>;
  },
): Promise<Response> {
  return (await handleSubscriptionRoute(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie },
    }),
    createTestAuth(database),
    new SubscriptionService(new PostgresSubscriptionRepository(database)),
    new SubscriptionDetailService(new PostgresSubscriptionDetailRepository(database)),
    completion,
  ))!;
}
