import { describe, expect, it } from "vitest";

import { DashboardApiError } from "../src/app/dashboard-api-client";
import { applyDetailRequestFailure, immediateRefreshNotice, initialDetailState } from "../src/app/dashboard-page-state";

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

  it("turns a completed manual refresh into a result notice", () => {
    // 仅在服务端采集完成后展示成功与待确认计数；页面不根据卡片数量自行推断本轮结果。
    expect(immediateRefreshNotice({
      status: "completed",
      executedAt: "2026-07-17T01:00:00.000Z",
      attempted: 5,
      collected: 3,
      stale: 2,
    })).toBe("已完成本次采集：成功 3 个地区，待确认 2 个地区。");
  });
});
