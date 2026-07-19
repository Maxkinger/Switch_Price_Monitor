import { describe, expect, it, vi } from "vitest";

import { createProductApiClient, ProductApiError } from "../src/app/api-client";
import { createApiRequestTracker } from "../src/app/api-request-tracker";

/**
 * 浏览器 API 客户端测试只验证本系统同源请求契约。它刻意注入请求函数而不启动 Worker，
 * 以防 UI 组件在重构时绕过受保护 `/api/products/*` 端点直接请求任天堂或第三方价格网站。
 */
describe("product API client", () => {
  it("sends product searches to the protected same-origin API with the administrator cookie policy", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "available", candidates: [] }));
    const client = createProductApiClient(request);

    await expect(client.searchProducts("Overcooked")).resolves.toEqual({ status: "available", candidates: [] });
    expect(request).toHaveBeenCalledWith("/api/products/search", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Overcooked" }),
    }));
  });

  it("preserves only the 401 status and safe Worker summary so the authentication shell can discard stale wizard state", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "请先登录。" }, { status: 401 }));

    await expect(createProductApiClient(request).searchProducts("Overcooked"))
      .rejects.toEqual(expect.objectContaining({ name: "ProductApiError", message: "请先登录。", status: 401 }));
    await expect(createProductApiClient(request).searchProducts("Overcooked")).rejects.toBeInstanceOf(ProductApiError);
  });

  it("resolves configured regions without sending a browser-owned region list", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ regions: [] }));
    const client = createProductApiClient(request);

    await client.resolveRegions([candidate()]);

    // 启用地区是 Worker 设置的安全边界；客户端只能发送已经选定的默认区官方候选，不能携带 enabledRegions 覆盖范围。
    expect(request).toHaveBeenCalledWith("/api/products/resolve-regions", expect.objectContaining({
      body: JSON.stringify({ candidates: [candidate()] }),
      credentials: "same-origin",
    }));
  });

  it("sends the selected anchor when verifying a Japanese manual upgrade link", async () => {
    // 选中的默认区官方候选是日区升级包关系核验的唯一可信锚点；客户端必须原样转交给同源 Worker，不能只提交人工链接。
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidate: candidate() }));
    const client = createProductApiClient(request);
    const anchor = { ...candidate(), canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack", productType: "upgrade-pack" as const };
    const upgradeUrl = "https://store-jp.nintendo.com/item/software/D70050000064985/";

    await client.resolveOfficialLink("JP", upgradeUrl, anchor);
    expect(request).toHaveBeenCalledWith("/api/products/resolve-link", expect.objectContaining({ body: JSON.stringify({ regionCode: "JP", productUrl: upgradeUrl, anchor }) }));
  });

  it("keeps the global request count active until product discovery settles", async () => {
    // 请求尚未结算时必须显示遮罩；只断言最终为零会让根本未接入计数器的客户端虚假通过。
    const tracker = createApiRequestTracker();
    let resolveRequest: (response: Response) => void = () => undefined;
    const client = createProductApiClient(vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; })) as unknown as typeof fetch, tracker);
    const pending = client.searchProducts("Overcooked");

    expect(tracker.getPendingCount()).toBe(1);
    resolveRequest(Response.json({ status: "available", candidates: [] }));
    await pending;
    expect(tracker.getPendingCount()).toBe(0);
  });
});

/** 默认区候选只用于验证客户端请求形状；测试不访问外站，也不包含任何会话或实际价格来源数据。 */
function candidate() {
  return { regionCode: "US" as const, productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game" as const, currency: "USD", coverUrl: null, currentPriceMinor: 2499, regularPriceMinor: null };
}
