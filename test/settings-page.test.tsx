// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "../src/app/settings-page";
import { SettingsApiError } from "../src/app/settings-api-client";
import type { AppSettings } from "../src/shared/domain";

const configuredAi = { configured: true, model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" };
const unconfiguredAi = { configured: false, model: null, apiBaseUrl: null };

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
      getAiProviderConfiguration: vi.fn(async () => unconfiguredAi),
      saveAiProviderConfiguration: vi.fn(),
      clearAiProviderConfiguration: vi.fn(),
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

/** DeepSeek 卡片与公开偏好表单隔离，防止 Key 被普通 PATCH、状态回显或清除操作带出。 */
describe("设置页 DeepSeek AI 配置", () => {
  afterEach(() => {
    // 每个用例都会发起两个挂载读取；卸载可阻止迟到摘要覆盖下一个用例的秘密草稿断言。
    cleanup();
  });

  it("保存后只显示摘要且清空 API Key 草稿", async () => {
    // 若成功后仍绑定旧 Key，刷新、屏幕共享或后续 DOM 错误都可能泄露管理员刚输入的秘密。
    const user = userEvent.setup();
    const api = aiApi({ saveAiProviderConfiguration: vi.fn(async () => configuredAi) });
    render(<SettingsPage api={api} onUnauthorized={vi.fn()} />);

    await user.type(await screen.findByLabelText("DeepSeek API Key"), "secret-key");
    await user.click(screen.getByRole("button", { name: "保存 DeepSeek 配置" }));

    expect(await screen.findByText("DeepSeek 已配置；重新输入 Key 可替换配置。")).toBeTruthy();
    expect(screen.queryByDisplayValue("secret-key")).toBeNull();
    expect(api.saveAiProviderConfiguration).toHaveBeenCalledWith({ apiKey: "secret-key", model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" });
    expect(screen.getByLabelText("DeepSeek API Key").getAttribute("placeholder")).toBe("已保存，重新输入可替换");
  });

  it("清除需要页面内确认且不影响公开设置草稿", async () => {
    // 若第一次点击直接删除，误触会让名称核验立即失去 AI 能力；若复用公开表单状态，又可能丢失管理员未保存偏好。
    const user = userEvent.setup();
    const api = aiApi({ clearAiProviderConfiguration: vi.fn(async () => undefined) });
    render(<SettingsPage api={api} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "清除 DeepSeek 配置" }));
    expect(api.clearAiProviderConfiguration).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认清除" }));

    expect(api.clearAiProviderConfiguration).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("DeepSeek 未配置；中文名称仍可手工填写。")).toBeTruthy();
    expect(screen.getByLabelText("默认搜索区")).toBeTruthy();
  });

  it("安全未配置摘要仍可确认清除并重新保存", async () => {
    // 服务端会把不存在与不可解密文统一为未配置，页面不能据此暴露密文存在性；但 DELETE 本身幂等，必须保留恢复入口以便管理员清除旧密文后重配。
    const user = userEvent.setup();
    const clearAiProviderConfiguration = vi.fn(async () => undefined);
    const saveAiProviderConfiguration = vi.fn(async () => configuredAi);
    const api = aiApi({
      getAiProviderConfiguration: vi.fn(async () => unconfiguredAi),
      clearAiProviderConfiguration,
      saveAiProviderConfiguration,
    });
    render(<SettingsPage api={api} onUnauthorized={vi.fn()} />);

    await screen.findByText("DeepSeek 未配置；中文名称仍可手工填写。");
    await user.click(screen.getByRole("button", { name: "清除 DeepSeek 配置" }));
    await user.click(screen.getByRole("button", { name: "确认清除" }));
    expect(clearAiProviderConfiguration).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText("DeepSeek API Key"), "replacement-key");
    await user.click(screen.getByRole("button", { name: "保存 DeepSeek 配置" }));
    expect(saveAiProviderConfiguration).toHaveBeenCalledWith({ apiKey: "replacement-key", model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" });
    expect(screen.queryByText(/密文|主密钥|不可解/)).toBeNull();
  });

  it("校验错误保留 Key 草稿以便修正，401 则立即丢弃并交给认证外壳", async () => {
    // 422 若清空会迫使管理员重复输入秘密；401 若保留则可能把过期会话中的 Key 留在受保护页面内存。
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    const api = aiApi({ saveAiProviderConfiguration: vi.fn(async () => { throw new SettingsApiError("AI 配置无效。", 422); }) });
    const { rerender } = render(<SettingsPage api={api} onUnauthorized={onUnauthorized} />);

    await user.type(await screen.findByLabelText("DeepSeek API Key"), "retry-key");
    await user.click(screen.getByRole("button", { name: "保存 DeepSeek 配置" }));
    expect(await screen.findByDisplayValue("retry-key")).toBeTruthy();
    expect(screen.getByText("AI 配置无效。")).toBeTruthy();

    const unauthorizedApi = aiApi({ saveAiProviderConfiguration: vi.fn(async () => { throw new SettingsApiError("请先登录。", 401); }) });
    rerender(<SettingsPage api={unauthorizedApi} onUnauthorized={onUnauthorized} />);
    await user.click(screen.getByRole("button", { name: "保存 DeepSeek 配置" }));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("DeepSeek API Key").getAttribute("value")).toBe("");
  });
});

/** 该测试替身保留 SettingsPage 实际依赖的完整方法集，并隔离网络边界而不替代页面状态机。 */
function aiApi(overrides: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn(async () => settings()),
    saveSettings: vi.fn(async () => settings()),
    testProxy: vi.fn(async () => ({ http: "proxy-success" as const, browser: "proxy-success" as const })),
    getAiProviderConfiguration: vi.fn(async () => configuredAi),
    saveAiProviderConfiguration: vi.fn(async () => configuredAi),
    clearAiProviderConfiguration: vi.fn(async () => undefined),
    ...overrides,
  };
}

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
