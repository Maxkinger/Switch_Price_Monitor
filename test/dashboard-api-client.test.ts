import { describe, expect, it, vi } from "vitest";

import { DashboardApiError, createDashboardApiClient } from "../src/app/dashboard-api-client";

/**
 * 浏览器数据客户端测试确认它只请求本站 Worker，并把 API 的节流提示转换为可展示的受控错误。
 * 这里不使用真实网络，避免测试意外携带管理员 Cookie 或访问任天堂、汇率与第三方价格站。
 */
describe("dashboard API client", () => {
  it("uses same-origin credentials for dashboard detail and subscription writes", async () => {
    // 每次调用返回最小合法 JSON；断言集中验证请求路径与凭据策略，避免前端跨域读取受保护价格数据。
    const request = vi.fn(async () => Response.json({ subscriptions: [], stats: {} })) as unknown as typeof fetch;
    const client = createDashboardApiClient(request);

    await client.getDashboard();
    await client.getSubscription("subscription-overcooked-2");
    await client.updateSubscription("subscription-overcooked-2", { enabled: false });

    expect(request).toHaveBeenNthCalledWith(1, "/api/dashboard", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    expect(request).toHaveBeenNthCalledWith(2, "/api/subscriptions/subscription-overcooked-2", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    expect(request).toHaveBeenNthCalledWith(3, "/api/subscriptions/subscription-overcooked-2", expect.objectContaining({ method: "PATCH", credentials: "same-origin" }));
  });

  it("preserves a refresh cooldown timestamp without retaining an API response body", async () => {
    // 429 只给页面显示下一可请求时间，错误对象不能保留可能含敏感内容的原始 JSON 或 Response 实例。
    const request = vi.fn(async () => Response.json(
      { error: "刷新过于频繁。", nextAllowedAt: "2026-07-17T01:15:00.000Z" },
      { status: 429 },
    )) as unknown as typeof fetch;

    await expect(createDashboardApiClient(request).queueRefresh()).rejects.toEqual(
      new DashboardApiError("刷新过于频繁。", 429, "2026-07-17T01:15:00.000Z"),
    );
  });
});
