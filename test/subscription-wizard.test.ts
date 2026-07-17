import { describe, expect, it } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import {
  candidatePriceLabel,
  createSubscriptionWizardState,
  hasNoOfficialCandidates,
  setRegionalCandidate,
  toggleCandidate,
} from "../src/app/subscription-wizard";

/**
 * 添加订阅向导的纯状态测试不依赖 React、网络或 D1。它固定多选、价格与跨区映射的业务语义，
 * 防止视觉层重构时把两款游戏的香港候选串在一起，或把未验证价格误显示为促销。
 */
describe("subscription wizard state", () => {
  it("toggles whole cards independently so two selected games remain selected", () => {
    const initial = createSubscriptionWizardState({ status: "available", candidates: [overcooked(), kirby()] });

    const first = toggleCandidate(initial, "US:overcooked");
    const second = toggleCandidate(first, "US:kirby");

    expect(second.selectedCandidateKeys).toEqual(["US:overcooked", "US:kirby"]);
    expect(toggleCandidate(second, "US:overcooked").selectedCandidateKeys).toEqual(["US:kirby"]);
  });

  it("shows a struck regular price, sale price and discount only when the verified sale is lower", () => {
    expect(candidatePriceLabel({ ...overcooked(), currentPriceMinor: 999, regularPriceMinor: 2499 })).toEqual({
      kind: "sale",
      regularMinor: 2499,
      currentMinor: 999,
      discountPercent: 60,
    });
    expect(candidatePriceLabel({ ...overcooked(), currentPriceMinor: null, regularPriceMinor: null })).toEqual({ kind: "pending" });
  });

  it("stores a Hong Kong confirmation under its own selected-game key", () => {
    const initial = createSubscriptionWizardState({ status: "available", candidates: [overcooked(), kirby()] });
    const next = setRegionalCandidate(initial, "US:kirby", "HK", hongKongKirby());

    expect(next.regionalConfirmations["US:kirby:HK"]).toEqual(hongKongKirby());
    expect(next.regionalConfirmations["US:overcooked:HK"]).toBeUndefined();
  });

  it("identifies a successful official search with no candidates so the page can show a next step", () => {
    // 官方接口正常返回空数组不等同于网络故障；但首次进入的初始空模型没有提交过查询，不能错误显示为“未找到”。
    expect(hasNoOfficialCandidates({ status: "available", candidates: [] }, "")).toBe(false);
    expect(hasNoOfficialCandidates({ status: "available", candidates: [] }, "OverCooked2")).toBe(true);
    expect(hasNoOfficialCandidates({ status: "available", candidates: [overcooked()] }, "Overcooked! 2")).toBe(false);
    expect(hasNoOfficialCandidates({ status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" }, "Overcooked! 2")).toBe(false);
  });
});

/** 美区《胡闹厨房 2》含常规价，作为促销和当前价显示规则的稳定基线。 */
function overcooked(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "USD", coverUrl: null, currentPriceMinor: 2499, regularPriceMinor: 2499 };
}

/** 第二张美区候选证明卡片选择必须是集合操作，不能因同一区而互相替换。 */
function kirby(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/kirby-and-the-forgotten-land-switch/", canonicalTitle: "Kirby and the Forgotten Land", publisher: "Nintendo", productType: "game", currency: "USD", coverUrl: null, currentPriceMinor: 5999, regularPriceMinor: null };
}

/** 香港候选具有独立地区、币种和官方链接，避免状态机依赖美区候选的 URL 或价格。 */
function hongKongKirby(): OfficialProductCandidate {
  return { regionCode: "HK", productUrl: "https://www.nintendo.com/hk/soft/kirby-and-the-forgotten-land/", canonicalTitle: "Kirby and the Forgotten Land", publisher: "Nintendo", productType: "game", currency: "HKD", coverUrl: null, currentPriceMinor: 46800, regularPriceMinor: null };
}
