// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/app/app-shell";

/**
 * 应用外壳的版本标识必须来自构建版本，而不是管理员数据或网络响应；该测试固定仪表盘读取结果，
 * 从而保证未来调整导航布局时仍能发现发布批次标识被遗漏的问题。
 */
describe("应用壳发布版本", () => {
  afterEach(() => {
    // 每个用例恢复 DOM、fetch mock 与路由，避免仪表盘首屏请求残留而影响版本标识的独立断言。
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("shows the package release version at the bottom of the navigation", async () => {
    // 应用壳首屏会读取仪表盘；使用完整固定响应避免网络状态干扰导航中静态构建版本的验证。
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      stats: { monitoredSubscriptionCount: 0, availableRegionPriceCount: 0, lastCapturedAt: null, nextDailyReportAt: null },
      subscriptions: [],
    })));

    render(<AppShell onUnauthorized={vi.fn()} />);

    // 项目未引入 jest-dom 断言扩展；确认元素被 Testing Library 找到即可证明导航已输出版本文本。
    expect(await screen.findByText("V 0.0.1")).not.toBeNull();
  });
});
