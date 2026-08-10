// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "../src/app/settings-page";
import type { AppSettings } from "../src/shared/domain";

/** 设置页代理卡片只暴露无认证四字段，测试操作也不得意外触发公开设置保存。 */
describe("设置页网络代理", () => {
  afterEach(() => {
    // 每个 jsdom 用例显式卸载异步设置页，防止前一代理测试状态污染后续表单断言。
    cleanup();
  });

  it("tests only the current proxy draft and renders the two safe transport results", async () => {
    // 测试按钮必须传递当前未保存草稿；没有用户名或密码控件，连接结果只显示固定三态而不显示端点或响应正文。
    const user = userEvent.setup();
    const api = {
      getSettings: vi.fn(async () => settings()),
      saveSettings: vi.fn(),
      testProxy: vi.fn(async () => ({ http: "proxy-success" as const, browser: "direct-fallback-success" as const })),
    };
    render(<SettingsPage api={api} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "测试连接" }));

    expect(api.testProxy).toHaveBeenCalledWith({ enabled: false, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(await screen.findByText("普通 HTTPS：代理连接成功")).toBeTruthy();
    expect(screen.getByText("浏览器 HTTPS：代理失败，直连成功")).toBeTruthy();
    expect(screen.queryByLabelText(/用户名|密码/)).toBeNull();
  });
});

/** 使用完整公开设置 DTO，代理字段刻意省略以验证升级旧响应时页面建立关闭默认草稿。 */
function settings(): AppSettings {
  return {
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
    theme: "warm-card",
    timezone: "Asia/Shanghai",
    dailyReportTime: "09:00",
    taxState: "OR",
    priceHistoryRetention: "forever",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}
