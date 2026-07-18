import { describe, expect, it, vi } from "vitest";

import type { AppSettings } from "../src/shared/domain";
import { SettingsApiError, createSettingsApiClient } from "../src/app/settings-api-client";
import { createApiRequestTracker } from "../src/app/api-request-tracker";
import { createSettingsForm, toPublicSettingsPatch } from "../src/app/settings-form";

/**
 * 设置客户端测试只注入本地 fetch 桩，证明浏览器只调用站内公开设置接口；
 * 任何失败响应都不得把 Response、Cookie 或可能含秘密的未知 JSON 留在错误对象中。
 */
describe("public settings API client", () => {
  it("uses same-origin credentials for settings reads and writes", async () => {
    // GET 与 PATCH 共用同一个固定站内路径，避免设置页绕过 Worker 会话守卫或跨域传递管理员偏好。
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(settings()));
    const client = createSettingsApiClient(request);
    const patch = toPublicSettingsPatch(createSettingsForm(settings()));

    await client.getSettings();
    await client.saveSettings(patch);

    expect(request).toHaveBeenNthCalledWith(1, "/api/settings", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    expect(request).toHaveBeenNthCalledWith(2, "/api/settings", expect.objectContaining({
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }));
  });

  it("turns a safe Worker validation summary into a status-aware error", async () => {
    // 422 的可展示摘要供表单保留草稿后修正；错误类型只含消息和状态，不能泄露响应原文。
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "默认搜索区必须属于已选地区。" }, { status: 422 }));

    await expect(createSettingsApiClient(request).getSettings())
      .rejects.toEqual(new SettingsApiError("默认搜索区必须属于已选地区。", 422));
  });

  it("keeps the global request count active until a settings request settles", async () => {
    // 设置读取尚未返回时也必须计入遮罩，防止页面先显示旧草稿再异步覆盖。
    const tracker = createApiRequestTracker();
    let resolveRequest: (response: Response) => void = () => undefined;
    const client = createSettingsApiClient(vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; })) as unknown as typeof fetch, tracker);
    const pending = client.getSettings();

    expect(tracker.getPendingCount()).toBe(1);
    resolveRequest(Response.json(settings()));
    await pending;
    expect(tracker.getPendingCount()).toBe(0);
  });
});

/** 与设置路由的完整公开 DTO 对齐；夹具不含任何管理员密码、会话或 Telegram 字段。 */
function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
    theme: "warm-card",
    timezone: "Asia/Shanghai",
    dailyReportTime: "09:00",
    taxState: "OR",
    priceHistoryRetention: "forever",
    createdAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}
