import { describe, expect, it } from "vitest";

import type { AppSettings } from "../src/shared/domain";
import {
  createSettingsForm,
  setSettingsDefaultRegion,
  toPublicSettingsPatch,
  toggleSettingsRegion,
} from "../src/app/settings-form";

/**
 * 设置草稿测试固定前端联动边界：浏览器可以预防默认区失效，却不能携带初始化时间或秘密字段；
 * Worker 仍会在 PATCH 时重做校验，因此这些案例不模拟或读取会话 Cookie。
 */
describe("public settings form state", () => {
  it("keeps the final enabled region and moves the default region when it is disabled", () => {
    // 默认区被取消时必须立即选择剩余地区，避免管理员看到可保存但服务端必然拒绝的组合；最后一个地区不能取消。
    const initial = createSettingsForm(settings({ enabledRegions: ["US", "JP"], defaultSearchRegion: "US" }));
    const afterDefaultDisabled = toggleSettingsRegion(initial, "US");

    expect(afterDefaultDisabled).toMatchObject({ enabledRegions: ["JP"], defaultSearchRegion: "JP" });
    expect(toggleSettingsRegion(afterDefaultDisabled, "JP")).toEqual(afterDefaultDisabled);
  });

  it("only accepts an enabled default region", () => {
    // 受控下拉框外的值不能污染草稿；无效输入保持原状态，让页面继续显示服务器可接受的选项。
    const initial = createSettingsForm(settings({ enabledRegions: ["US", "HK"], defaultSearchRegion: "US" }));

    expect(setSettingsDefaultRegion(initial, "HK").defaultSearchRegion).toBe("HK");
    expect(setSettingsDefaultRegion(initial, "JP")).toEqual(initial);
  });

  it("builds a public settings PATCH without createdAt or secret fields", () => {
    // 初始化审计时间只归服务端所有；公开设置保存也绝不能为未来 Telegram 或认证字段预留自由入口。
    const patch = toPublicSettingsPatch(createSettingsForm(settings()));

    expect(patch).toEqual(expect.objectContaining({ enabledRegions: expect.any(Array), dailyReportTime: "09:00" }));
    expect(patch).not.toHaveProperty("createdAt");
    expect(JSON.stringify(patch)).not.toContain("Telegram");
  });
});

/** 使用完整公开设置夹具，避免测试靠省略字段掩盖 PATCH 构造时的字段遗失。 */
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
