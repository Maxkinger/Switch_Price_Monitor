import { describe, expect, it } from "vitest";

import type { AppSettings } from "../src/shared/domain";
import { SettingsApiError } from "../src/app/settings-api-client";
import { createSettingsForm } from "../src/app/settings-form";
import { applySettingsRequestFailure } from "../src/app/settings-page-state";

/**
 * 设置页面错误状态测试确保校验失败不会抹掉管理员刚编辑的公开偏好，
 * 而认证失效必须丢弃草稿，避免登录入口后继续在浏览器内存保留管理员设置。
 */
describe("settings page request state", () => {
  it("keeps the public settings draft after a 422 and drops it after a 401", () => {
    // Worker 对时间等跨字段规则有最终决定权；422 需要保留草稿供修正，401 则不能保留任何受保护页面数据。
    const draft = createSettingsForm(settings({ dailyReportTime: "25:99" }));

    expect(applySettingsRequestFailure(draft, new SettingsApiError("日报时间无效。", 422)))
      .toMatchObject({ kind: "ready", draft, error: "日报时间无效。" });
    expect(applySettingsRequestFailure(draft, new SettingsApiError("请先登录。", 401))).toEqual({ kind: "unauthorized" });
  });
});

/**
 * 完整公开设置夹具刻意不含 Telegram、密码或会话字段，符合本阶段的安全范围。
 * 地区数组保持可变类型，模拟 D1/API 反序列化后的真实领域数据，避免只读测试常量掩盖赋值边界。
 */
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
