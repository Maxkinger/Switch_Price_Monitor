import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleProductRoute } from "../src/routes/product-routes";
import type { AppDatabase } from "../src/server/database/types";
import { AuthService } from "../src/services/auth-service";
import { SubscriptionPreviewService } from "../src/services/subscription-preview-service";
import { createApiTestDatabase, createTestAuth, initializeAndLogin as initializeAdmin, resetApiTestData } from "./support/api-postgres";

// 预览只读断言与认证 helper 共享一次性 PostgreSQL；所有任天堂解析都由 fixedPreview 截断，不会联网。
let database: AppDatabase;

/**
 * 商品来源预览路由测试通过真实管理员会话验证授权边界，但向预览服务注入内存解析器。
 * 这样既覆盖 HTTP 输入收窄，也确保测试不会向任天堂发请求或因预览操作插入任何业务记录。
 */
describe("product source preview HTTP route", () => {
  beforeAll(async () => { database = await createApiTestDatabase(); });
  afterAll(async () => { await database.close(); });

  beforeEach(async () => {
    // 预览必须是只读操作；清空一次性库后可以精确验证它不会创建游戏、地区商品或订阅。
    await resetApiTestData(database);
  });

  it("returns source previews without a cookie during local development without persisting candidates", async () => {
    // 直入仅取消认证，不得使只读预览写入候选、订阅或地区商品。
    const preview = fixedPreview();
    const before = await counts();
    const response = await handleProductRoute(request([jpCandidate(), hkCandidate()]), sessions(), preview);

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ regions: [
      { regionCode: "JP", officialStatus: "official-available", officialPriceId: "70050000064985" },
      { regionCode: "HK", officialStatus: "official-id-unavailable", fallbackSources: ["eshop-prices", "nt-deals"], canMonitor: true },
    ] });
    // 调用预览仅帮助管理员决定是否继续创建订阅；必须不改变任何后续采集范围或历史关联。
    await expect(counts()).resolves.toEqual(before);
  });

  it("rejects duplicate regions and malformed candidates with a safe validation response", async () => {
    const cookie = await initializeAndLogin();
    const duplicate = await handleProductRoute(request([jpCandidate(), { ...jpCandidate(), productUrl: "https://example.test/second" }], cookie), sessions(), fixedPreview());
    expect(duplicate?.status).toBe(422);
    await expect(duplicate?.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "每个地区只能确认一个商品。" });
  });
});

/** 使用固定解析结果替代外部官方接口，测试路由的认证、输入和无持久化职责而不是网络细节。 */
function fixedPreview(): SubscriptionPreviewService {
  return new SubscriptionPreviewService({
    resolve: async (candidate) => candidate.regionCode === "JP"
      ? { status: "official-available", officialPriceId: "70050000064985" }
      : { status: "official-id-unavailable", officialPriceId: null, reason: "unsupported-region" },
  }, ["eshop-prices", "nt-deals"]);
}

/** 路由测试显式装配 PostgreSQL 认证适配器，Cookie 仍由真实 PBKDF2 登录流程签发。 */
function sessions(): AuthService {
  return createTestAuth(database);
}

/** 日区候选使用已确认的官方链接；路由仍会验证 HTTPS、标题、发行商、商品类型和地区代码。 */
function jpCandidate() {
  return {
    regionCode: "JP",
    currency: "JPY",
    productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
  };
}

/** 港区候选没有首版官方 ID 解析器，预览应明确呈现第三方回退而非假装官方可用。 */
function hkCandidate() {
  return { ...jpCandidate(), regionCode: "HK", currency: "HKD", productUrl: "https://www.nintendo.com/hk/" };
}

/** 以 JSON 请求构造管理员调用，Cookie 只来自真实登录端点，避免测试伪造会话摘要。 */
function request(candidates: unknown[], cookie?: string): Request {
  return new Request("https://example.test/api/products/preview-sources", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ candidates }),
  });
}

/** 首次初始化与登录产生真实安全 Cookie，让预览路由与其他管理员 API 使用同一认证守卫。 */
async function initializeAndLogin(): Promise<string> {
  return (await initializeAdmin(database, { enabledRegions: ["JP", "HK"], defaultSearchRegion: "JP" })).cookie;
}

/** 返回所有不应被预览写入的核心业务记录数，作为只读接口的回归保护。 */
async function counts(): Promise<{ games: number; products: number; subscriptions: number }> {
  // PostgreSQL count 原生为 bigint 字符串；夹具用 ::int 明确收窄安全的小表计数，避免测试把驱动差异当业务差异。
  const [games, products, subscriptions] = await Promise.all([
    database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM games"),
    database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM regional_products"),
    database.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM subscriptions"),
  ]);
  return {
    games: games.rows[0]?.count ?? 0,
    products: products.rows[0]?.count ?? 0,
    subscriptions: subscriptions.rows[0]?.count ?? 0,
  };
}
