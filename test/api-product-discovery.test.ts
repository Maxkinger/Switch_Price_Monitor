import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/worker";
import { JapaneseUpgradeBatchLimitError } from "../src/worker/providers/japanese-upgrade-browser";
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
    // 路由依赖已扩展为完整的发现契约；未被本用例调用的方法仍给出受控空结果，防止类型检查遗漏接口变更。
    const discovery = {
      searchDefaultRegion: async () => ({ status: "available" as const, candidates: [candidate()] }),
      resolveOfficialLink: async () => candidate(),
      resolveRegions: async () => [],
    };
    const anonymous = await handleProductRoute(request("/api/products/search", { query: "Overcooked" }), env.DB, fixedPreview(), discovery);
    expect(anonymous?.status).toBe(401);

    const cookie = await initializeAndLogin();
    const response = await handleProductRoute(request("/api/products/search", { query: "Overcooked" }, cookie), env.DB, fixedPreview(), discovery);
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: "available", candidates: [candidate()] });
  });

  it("returns a verified Hong Kong candidate only after an administrator submits its official link", async () => {
    // 解析桩件模拟已由服务层验证的香港官方页面；路由本身只负责认证、输入边界和受控 DTO 的返回。
    const resolveOfficialLink = vi.fn(async () => hongKongCandidate());
    const discovery = {
      searchDefaultRegion: async () => ({ status: "available" as const, candidates: [candidate()] }),
      resolveOfficialLink,
      resolveRegions: async () => [],
    };
    const cookie = await initializeAndLogin();

    const response = await handleProductRoute(
      request("/api/products/resolve-link", { regionCode: "HK", productUrl: hongKongCandidate().productUrl }, cookie),
      env.DB,
      fixedPreview(),
      discovery,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ candidate: hongKongCandidate() });
    expect(resolveOfficialLink).toHaveBeenCalledWith("HK", hongKongCandidate().productUrl);
  });

  it("forwards a complete Japanese upgrade anchor only after narrowing it as an official candidate", async () => {
    // 浏览器可伪造标题字符串；路由必须完整收窄锚点后才交给日区关系服务，令升级包链接的关系证明始终由 Worker 完成。
    const resolveOfficialLink = vi.fn(async () => japaneseUpgradeCandidate());
    const discovery = {
      searchDefaultRegion: async () => ({ status: "available" as const, candidates: [candidate()] }),
      resolveOfficialLink,
      resolveRegions: async () => [],
    };
    const cookie = await initializeAndLogin();
    const anchor = { ...candidate(), canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack", productType: "upgrade-pack" as const };

    const response = await handleProductRoute(
      request("/api/products/resolve-link", { regionCode: "JP", productUrl: japaneseUpgradeCandidate().productUrl, anchor }, cookie),
      env.DB,
      fixedPreview(),
      discovery,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ candidate: japaneseUpgradeCandidate() });
    expect(resolveOfficialLink).toHaveBeenCalledWith("JP", japaneseUpgradeCandidate().productUrl, anchor);
  });

  it("rejects an incomplete Japanese upgrade anchor before invoking official-link discovery", async () => {
    // 只提交标题或 URL 的伪锚点不能证明升级包类型；路由必须按完整官方候选收窄，避免浏览器把任意文本送入关系服务。
    const resolveOfficialLink = vi.fn(async () => japaneseUpgradeCandidate());
    const discovery = { searchDefaultRegion: async () => ({ status: "available" as const, candidates: [] }), resolveOfficialLink, resolveRegions: async () => [] };
    const cookie = await initializeAndLogin();

    const response = await handleProductRoute(
      request("/api/products/resolve-link", { regionCode: "JP", productUrl: japaneseUpgradeCandidate().productUrl, anchor: { canonicalTitle: "伪造升级包" } }, cookie),
      env.DB,
      fixedPreview(),
      discovery,
    );

    expect(response?.status).toBe(422);
    const payload = await response?.json() as { code?: string; error?: string };
    // 收窄顺序可能首先拒绝地区或其它缺失字段；安全契约只要求 422 与受控代码，且绝不回显浏览器伪造标题、链接或内部异常。
    expect(payload.code).toBe("VALIDATION_ERROR");
    expect(payload.error).not.toContain("伪造升级包");
    expect(payload.error).not.toContain(japaneseUpgradeCandidate().productUrl);
    expect(payload.error).not.toContain("internal");
    expect(resolveOfficialLink).not.toHaveBeenCalled();
  });

  it("maps a Japanese upgrade batch limit error to a safe validation response", async () => {
    // 超过 Browser Run 批量上限是管理员可修正的输入问题，路由必须保留受控中文说明而不能归类为 500 或泄漏内部堆栈。
    const discovery = {
      searchDefaultRegion: async () => ({ status: "available" as const, candidates: [] }),
      resolveOfficialLink: async () => candidate(),
      resolveRegions: async () => { throw new JapaneseUpgradeBatchLimitError("一次最多核验 3 个日区升级包，请分批处理。"); },
    };
    const cookie = await initializeAndLogin();

    const response = await handleProductRoute(request("/api/products/resolve-regions", { candidates: [candidate()] }, cookie), env.DB, fixedPreview(), discovery);

    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "一次最多核验 3 个日区升级包，请分批处理。" });
  });

  it("returns a per-region manual-link state using the server-configured enabled regions", async () => {
    // 多选候选先由默认区搜索产生；路由不能把浏览器提交的地区范围传给服务，否则旧页面可绕过当前设置。
    const resolveRegions = vi.fn(async () => [{
      candidateKey: `US:${candidate().productUrl}`,
      regionCode: "HK" as const,
      status: "needs-manual-link" as const,
    }]);
    const discovery = {
      searchDefaultRegion: async () => ({ status: "available" as const, candidates: [candidate()] }),
      resolveOfficialLink: async () => hongKongCandidate(),
      resolveRegions,
    };
    const cookie = await initializeAndLogin();

    const response = await handleProductRoute(
      request("/api/products/resolve-regions", { candidates: [candidate()] }, cookie),
      env.DB,
      fixedPreview(),
      discovery,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ regions: [{
      candidateKey: `US:${candidate().productUrl}`,
      regionCode: "HK",
      status: "needs-manual-link",
      message: "请粘贴该区任天堂官方商品链接",
    }] });
    expect(resolveRegions).toHaveBeenCalledWith([candidate()]);
  });

  it("rejects browser-provided enabled regions before invoking regional discovery", async () => {
    // 启用地区是管理员设置中的服务器事实来源；若路由接受请求体中的覆盖值，
    // 旧页面或篡改请求就能缩小或扩大任天堂官网查询范围，因此必须在读取 JSON 时直接拒绝。
    const resolveRegions = vi.fn(async () => []);
    const discovery = {
      searchDefaultRegion: async () => ({ status: "available" as const, candidates: [candidate()] }),
      resolveOfficialLink: async () => hongKongCandidate(),
      resolveRegions,
    };
    const cookie = await initializeAndLogin();

    const response = await handleProductRoute(
      request("/api/products/resolve-regions", { candidates: [candidate()], enabledRegions: ["HK"] }, cookie),
      env.DB,
      fixedPreview(),
      discovery,
    );

    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "跨区范围由已保存设置决定。" });
    expect(resolveRegions).not.toHaveBeenCalled();
  });

  it("confirms a validated batch only for an administrator and returns each created subscription", async () => {
    // 最终确认桩件不写 D1；该用例专门锁定路由的认证、受控请求装配和响应边界，真实原子写入由服务层测试覆盖。
    const confirm = vi.fn(async () => [{ gameId: "game-overcooked", subscriptionId: "subscription-overcooked", status: "created" as const }]);
    const discovery = {
      searchDefaultRegion: async () => ({ status: "available" as const, candidates: [candidate()] }),
      resolveOfficialLink: async () => candidate(),
      resolveRegions: async () => [],
    };
    const cookie = await initializeAndLogin();
    const input = confirmedSubscription();

    const response = await handleProductRoute(
      request("/api/products/confirm-subscriptions", { subscriptions: [input] }, cookie),
      env.DB,
      fixedPreview(),
      discovery,
      { confirm },
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toEqual({ subscriptions: [{ gameId: "game-overcooked", subscriptionId: "subscription-overcooked", status: "created" }] });
    expect(confirm).toHaveBeenCalledWith([input], expect.any(String));
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

/** 香港候选必须携带本区官方 URL 与港币；测试刻意不复用美区链接，防止跨区商品错误通过路由边界。 */
function hongKongCandidate() {
  return { regionCode: "HK" as const, productUrl: "https://www.nintendo.com/hk/soft/overcooked-2/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game" as const, currency: "HKD", coverUrl: "https://assets.nintendo.com/overcooked-2.jpg", currentPriceMinor: 7800, regularPriceMinor: null };
}

/** 日区升级包夹具使用受控官方 URL 和升级包类型，专门覆盖路由把完整锚点传入服务端关系复核的契约。 */
function japaneseUpgradeCandidate() {
  return { ...candidate(), regionCode: "JP" as const, productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/", canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス", productType: "upgrade-pack" as const, currency: "JPY", currentPriceMinor: 1000 };
}

/** 最终确认必须保留默认区的官方候选及其匹配来源；即使只有一个地区也不允许跳过该映射。 */
function confirmedSubscription() {
  return { selected: candidate(), regions: [{ ...candidate(), matchSource: "manual_selection" as const }], skippedRegionCodes: [] };
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

/** 静态资源与 Browser Binding 桩件若被调用会失败，确保旧发现 API 测试不意外进入前端回退或消耗受控浏览器会话。 */
function workerEnv(): Env {
  return {
    DB: env.DB,
    ASSETS: { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher,
    BROWSER: { fetch: async () => new Response("unexpected browser binding request", { status: 500 }) } as unknown as Fetcher,
  };
}
