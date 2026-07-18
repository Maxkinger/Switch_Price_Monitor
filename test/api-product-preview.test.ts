import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";
import { handleProductRoute } from "../src/worker/routes/product-routes";
import { SubscriptionPreviewService } from "../src/worker/services/subscription-preview-service";

/**
 * 商品来源预览路由测试通过真实管理员会话验证授权边界，但向预览服务注入内存解析器。
 * 这样既覆盖 HTTP 输入收窄，也确保测试不会向任天堂发请求或因预览操作插入任何业务记录。
 */
describe("product source preview HTTP route", () => {
  beforeEach(async () => {
    // 预览必须是只读操作；清空相关表后可以精确验证它不会创建游戏、地区商品或订阅。
    await env.DB.exec("DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
  });

  it("rejects anonymous access and returns source previews to a signed-in administrator without persisting candidates", async () => {
    const preview = fixedPreview();
    const anonymous = await handleProductRoute(request([jpCandidate()]), env.DB, preview);
    expect(anonymous?.status).toBe(401);

    const cookie = await initializeAndLogin();
    const before = await counts();
    const response = await handleProductRoute(request([jpCandidate(), hkCandidate()], cookie), env.DB, preview);

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
    const duplicate = await handleProductRoute(request([jpCandidate(), { ...jpCandidate(), productUrl: "https://example.test/second" }], cookie), env.DB, fixedPreview());
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
  const initialized = await worker.fetch!(requestToWorker("/api/auth/initialize", {
    password: "correct-horse-battery-staple",
    enabledRegions: ["JP", "HK"],
    defaultSearchRegion: "JP",
  }) as never, workerEnv(), {} as ExecutionContext);
  expect(initialized.status).toBe(201);
  const login = await worker.fetch!(requestToWorker("/api/auth/login", { password: "correct-horse-battery-staple" }) as never, workerEnv(), {} as ExecutionContext);
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie") ?? "";
}

/** 初始化/登录必须走 Worker；静态资源桩件会把遗漏的 API 路由立即暴露为 500。 */
function requestToWorker(path: string, body: unknown): Request {
  return new Request(`https://example.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** 预览测试不需要前端资产或 Browser Binding，两个失败桩件可防止路由意外回退或启动受控浏览器而掩盖只读边界。 */
function workerEnv(): Env {
  return {
    DB: env.DB,
    ASSETS: { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher,
    BROWSER: { fetch: async () => new Response("unexpected browser binding request", { status: 500 }) } as unknown as Fetcher,
  };
}

/** 返回所有不应被预览写入的核心业务记录数，作为只读接口的回归保护。 */
async function counts(): Promise<{ games: number; products: number; subscriptions: number }> {
  const [games, products, subscriptions] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM games"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM regional_products"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions"),
  ]);
  // D1 批量查询的泛型默认是未知对象；此处三条 SQL 都固定返回 count，显式收窄可让测试在编译期同步检查只读断言形状。
  return {
    games: (games.results[0] as { count: number } | undefined)?.count ?? 0,
    products: (products.results[0] as { count: number } | undefined)?.count ?? 0,
    subscriptions: (subscriptions.results[0] as { count: number } | undefined)?.count ?? 0,
  };
}
