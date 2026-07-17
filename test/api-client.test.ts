import { describe, expect, it, vi } from "vitest";

import { createProductApiClient, ProductApiError } from "../src/app/api-client";

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
});
