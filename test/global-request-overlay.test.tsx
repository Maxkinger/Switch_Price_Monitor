// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/app/app-shell";
import { GlobalRequestOverlay } from "../src/app/global-request-overlay";

/** 全局加载层只在已认证请求进行时出现，且不得包含请求内容、Cookie 或服务端错误等敏感信息。 */
describe("全局请求加载遮罩", () => {
  afterEach(() => {
    // 显式清理上一用例的组件和 fetch，避免独立遮罩残留而伪造应用壳接线已成功的结果。
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders an accessible status while a same-origin request is pending", () => {
    render(<GlobalRequestOverlay visible />);

    expect(screen.getByRole("status").textContent).toContain("正在同步数据…");
  });

  it("renders nothing after every request has settled", () => {
    const { container } = render(<GlobalRequestOverlay visible={false} />);

    expect(container.innerHTML).toBe("");
  });

  it("keeps the application overlay visible while the dashboard's same-origin request is pending", async () => {
    // 应用壳必须把同一个计数器注入首屏仪表盘客户端；此延迟响应能防止只测试独立遮罩而遗漏真实页面接线。
    let resolveDashboard: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveDashboard = resolve; })));
    window.history.replaceState(null, "", "/");

    render(<AppShell onUnauthorized={vi.fn()} />);

    expect((await screen.findByRole("status", { name: "正在同步数据" })).textContent).toContain("正在同步数据…");

    // 完整的受控概览响应使页面能安全结束首次读取；遮罩必须在请求 finally 完成后立刻撤销。
    resolveDashboard(Response.json({
      stats: {
        monitoredSubscriptionCount: 0,
        availableRegionPriceCount: 0,
        lastCapturedAt: null,
        nextDailyReportAt: null,
      },
      subscriptions: [],
    }));

    await waitFor(() => expect(screen.queryByRole("status", { name: "正在同步数据" })).toBeNull());
  });

  it("keeps the global overlay off while the settings AI summary is pending", async () => {
    // AI 配置读取只影响 DeepSeek 卡片；若它进入全局计数器，管理员会在公开偏好已加载后仍被全屏遮罩锁住，无法继续修改普通设置。
    let resolveAiSummary: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      if (input === "/api/settings") return Promise.resolve(Response.json(settings()));
      if (input === "/api/settings/ai-provider") return new Promise<Response>((resolve) => { resolveAiSummary = resolve; });
      throw new Error(`unexpected request: ${input}`);
    }));
    window.history.replaceState(null, "", "/settings");

    render(<AppShell onUnauthorized={vi.fn()} />);

    // 公开设置已可编辑时，全局遮罩必须保持关闭；AI 卡片自身仍禁用，避免摘要未确定前与保存/清除发生竞态。
    expect(await screen.findByLabelText("默认搜索区")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "正在同步数据" })).toBeNull();
    expect((screen.getByLabelText("DeepSeek API Key") as HTMLInputElement).matches(":disabled")).toBe(true);

    resolveAiSummary(Response.json({ configured: false, model: null, apiBaseUrl: null }));
    await waitFor(() => expect((screen.getByLabelText("DeepSeek API Key") as HTMLInputElement).matches(":disabled")).toBe(false));
  });
});

/** 设置路由公开 DTO 只含偏好字段，刻意不包含密码、会话或任何 AI Key。 */
function settings() {
  return {
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
    theme: "warm-card",
    timezone: "Asia/Shanghai",
    dailyReportTime: "09:00",
    taxState: "OR",
    priceHistoryRetention: "forever",
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}
