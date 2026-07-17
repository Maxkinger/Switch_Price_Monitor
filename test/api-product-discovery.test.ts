import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";
import { handleProductRoute } from "../src/worker/routes/product-routes";
import { SubscriptionPreviewService } from "../src/worker/services/subscription-preview-service";

/**
 * 商品发现 API 必须先验证管理员会话，再调用注入的发现服务。测试使用本地服务桩件，
 * 确保搜索接口既不会写入 D1，也不会在测试期间访问任天堂公开搜索或商品页。
 */
describe("product discovery HTTP routes", () => {
  beforeEach(async () => {
    // 发现操作是只读的；清理认证和业务表能证明接口不因搜索或解析留下半成品订阅数据。
    await env.DB.exec("DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
  });

  it("rejects anonymous default-region search and returns only the configured official candidates to an administrator", async () => {
    const discovery = { searchDefaultRegion: async () => ({ status: "available" as const, candidates: [candidate()] }) };
    const anonymous = await handleProductRoute(request("/api/products/search", { query: "Overcooked" }), env.DB, fixedPreview(), discovery);
    expect(anonymous?.status).toBe(401);

    const cookie = await initializeAndLogin();
    const response = await handleProductRoute(request("/api/products/search", { query: "Overcooked" }, cookie), env.DB, fixedPreview(), discovery);
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: "available", candidates: [candidate()] });
  });
});

/** 发现测试不需要价格 ID 网络验证，固定预览让路由的旧端点依然可被隔离地构造。 */
function fixedPreview(): SubscriptionPreviewService {
  return new SubscriptionPreviewService({ resolve: async () => ({ status: "official-id-unavailable", officialPriceId: null, reason: "unsupported-region" }) }, []);
}

/** 美区候选完整反映 API 应返回的公开字段，不携带任天堂响应正文、Cookie 或任意内部标识。 */
function candidate() {
  return { regionCode: "US" as const, productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game" as const, currency: "USD", coverUrl: null, currentPriceMinor: 999, regularPriceMinor: null };
}

/** 只构造本系统 JSON API 请求；Cookie 来自真实登录端点，避免测试伪造管理员会话。 */
function request(path: string, body: unknown, cookie?: string): Request {
  return new Request(`https://example.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}

/** 首次设置默认区后登录，测试 API 必须使用与生产相同的 HttpOnly 会话守卫。 */
async function initializeAndLogin(): Promise<string> {
  const initialized = await worker.fetch!(request("/api/auth/initialize", { password: "correct-horse-battery-staple", enabledRegions: ["US"], defaultSearchRegion: "US" }) as never, workerEnv(), {} as ExecutionContext);
  expect(initialized.status).toBe(201);
  const login = await worker.fetch!(request("/api/auth/login", { password: "correct-horse-battery-staple" }) as never, workerEnv(), {} as ExecutionContext);
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie") ?? "";
}

/** 静态资源桩件若被调用会失败，确保测试只覆盖 Worker API 而不是前端资源回退。 */
function workerEnv(): Env {
  return { DB: env.DB, ASSETS: { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher };
}
