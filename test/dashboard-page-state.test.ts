import { describe, expect, it } from "vitest";

import { DashboardApiError } from "../src/app/dashboard-api-client";
import type { OfficialProductCandidate } from "../src/shared/domain";
import { applyAutomaticMissingResolutions, applyDetailRequestFailure, immediateRefreshNotice, initialDetailState, missingRegionPresentation } from "../src/app/dashboard-page-state";

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

  it("auto-populates only Worker-verified automatic missing regions for later final completion", () => {
    // 详情页的自动结果应直接成为补全草稿，但不能调用写入接口；候选列表和链接兜底仍等待管理员操作，
    // 以确保“确认补全”是唯一的持久化入口，浏览器也不会自行推断跨区商品。
    const confirmations = applyAutomaticMissingResolutions([
      { candidateKey: "US:overcooked", regionCode: "JP" as const, status: "automatic" as const, candidate: japaneseCandidate() },
      // 服务端推荐数量只影响候选首屏显示；详情页状态机仍仅自动采用 automatic，人工候选绝不绕过管理员确认。
      { candidateKey: "US:overcooked", regionCode: "MX" as const, status: "needs-manual-selection" as const, message: "请选择该区官方候选商品", candidates: [mexicanCandidate()], featuredCandidateCount: 1 },
      { candidateKey: "US:overcooked", regionCode: "HK" as const, status: "needs-manual-link" as const, message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" },
    ]);

    expect(confirmations).toEqual({ JP: { ...japaneseCandidate(), matchSource: "automatic" } });
    expect(missingRegionPresentation("automatic")).toBe("automatic-readonly");
    expect(missingRegionPresentation("needs-manual-selection")).toBe("candidate-list");
    expect(missingRegionPresentation("needs-manual-link")).toBe("link-input");
  });
});

/** 日区候选由 Worker 已唯一匹配，详情页仅可读展示并把它带入最终“确认补全”草稿。 */
function japaneseCandidate(): OfficialProductCandidate {
  return { regionCode: "JP", productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/", canonicalTitle: "オーバークック２", publisher: "Team17", productType: "game", currency: "JPY", coverUrl: null, currentPriceMinor: 1000, regularPriceMinor: null };
}

/** 墨西哥候选代表本地化或歧义结果，必须停留在候选列表而不能由详情页自动写入草稿。 */
function mexicanCandidate(): OfficialProductCandidate {
  return { regionCode: "MX", productUrl: "https://www.nintendo.com/es-mx/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "MXN", coverUrl: null, currentPriceMinor: 24900, regularPriceMinor: null };
}
