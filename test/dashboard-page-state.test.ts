import { describe, expect, it } from "vitest";

import { DashboardApiError } from "../src/app/dashboard-api-client";
import { applyDetailRequestFailure, initialDetailState, refreshWaitingNotice } from "../src/app/dashboard-page-state";

/** 页面状态机测试将安全登出、表单草稿与刷新队列文案从 React 渲染中分离，避免错误处理分支彼此覆盖。 */
describe("dashboard page state", () => {
  it("keeps an invalid target draft after a 422 but clears all dashboard state after a 401", () => {
    // 目标价校验失败时管理员需要继续修正输入；认证失败则不能继续显示价格、地区或目标价等私有信息。
    const editing = {
      ...initialDetailState,
      targetDraft: { globalTargetCnyFen: 5000, regionTargets: [{ regionCode: "JP", targetAmountMinor: 800 }] },
    };
    const invalid = applyDetailRequestFailure(editing, new DashboardApiError("目标价设置无效。", 422));

    expect(invalid).toMatchObject({ kind: "ready", targetDraft: { globalTargetCnyFen: 5000 }, error: "目标价设置无效。" });
    expect(applyDetailRequestFailure(invalid, new DashboardApiError("请先登录。", 401))).toEqual({ kind: "unauthorized" });
  });

  it("turns a queued refresh response into an honest waiting notice", () => {
    // 202 仅表示 Worker 已写入队列，页面不得把它表述为已完成价格抓取。
    expect(refreshWaitingNotice({ status: "queued", requestedAt: "2026-07-17T00:00:00.000Z", nextAllowedAt: "2026-07-17T00:15:00.000Z" })).toBe("已排队，等待采集任务执行。");
  });
});
