import { describe, expect, it } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import {
  applyAutomaticRegionResolutions,
  candidatePriceLabel,
  canConfirmConfiguredRegions,
  canConfirmChineseNames,
  createSubscriptionWizardState,
  hasNoOfficialCandidates,
  selectCandidate,
  setChineseNameDraft,
  setRegionalCandidate,
  skipRegionalConfirmation,
  toggleCandidate,
} from "../src/app/subscription-wizard";

/**
 * 添加订阅向导的纯状态测试不依赖 React、网络或 PostgreSQL。它固定单选切换、价格与跨区映射的业务语义，
 * 防止视觉层重构后把前一款游戏的地区候选或中文草稿带入新选择，或把未验证价格误显示为促销。
 */
describe("subscription wizard state", () => {
  it("selects at most one candidate and clears the prior candidate context", () => {
    // 切换商品必须整体丢弃旧候选的草稿、地区决定和来源预览；这些键都绑定具体商品，保留会让 AI 名称或官方地区链接串到新商品。
    const populated = {
      ...createSubscriptionWizardState({ status: "available", candidates: [overcooked(), kirby()] }),
      selectedCandidateKeys: ["US:overcooked"],
      chineseNameDrafts: { "US:overcooked": "胡闹厨房 2" },
      regionalConfirmations: { "US:overcooked:HK": { ...overcooked(), regionCode: "HK" as const, productUrl: "https://www.nintendo.com/hk/overcooked" } },
      regionalConfirmationSources: { "US:overcooked:HK": "automatic" as const },
      skippedRegionalKeys: ["US:overcooked:JP"],
      sourcePreviews: { "US:overcooked": [] },
    };
    const first = selectCandidate(populated, "US:overcooked");
    const switched = selectCandidate(first, "US:kirby");

    expect(switched.selectedCandidateKeys).toEqual(["US:kirby"]);
    expect(switched.chineseNameDrafts).toEqual({});
    expect(switched.regionalConfirmations).toEqual({});
    expect(switched.regionalConfirmationSources).toEqual({});
    expect(switched.skippedRegionalKeys).toEqual([]);
    expect(switched.sourcePreviews).toEqual({});
    expect(selectCandidate(switched, "US:kirby").selectedCandidateKeys).toEqual([]);

    // 旧页面入口在过渡期也必须执行完全相同的单选清理，不能因兼容层回退为多选并遗留旧商品的官方地区确认。
    expect(toggleCandidate(populated, "US:kirby")).toEqual(selectCandidate(populated, "US:kirby"));
  });

  it("keeps Chinese-name drafts independent for each selected default-region candidate", () => {
    // 中文显示名只是一轮向导中的管理员候选，不能以标题或数组下标作键；否则批量订阅两款商品时，后一项输入会覆盖前一项并把错误名称交给服务端复核。
    const initial = createSubscriptionWizardState({ status: "available", candidates: [overcooked(), kirby()] });
    const overcookedKey = `US:${overcooked().productUrl}`;
    const kirbyKey = `US:${kirby().productUrl}`;
    const first = setChineseNameDraft(initial, overcookedKey, "胡闹厨房 2");
    const next = setChineseNameDraft(first, kirbyKey, "星之卡比 探索发现");

    expect(next.chineseNameDrafts).toEqual({
      [overcookedKey]: "胡闹厨房 2",
      [kirbyKey]: "星之卡比 探索发现",
    });
  });

  it("requires every selected candidate to have a nonblank Chinese-name draft before confirmation", () => {
    // 目录建议仅改善输入体验，未命中词条时仍必须显式填写。这里锁定前端门禁，避免浏览器把空值发送到原子订阅确认并让整批请求在服务端才失败。
    const selected = [overcooked(), kirby()];
    const initial = createSubscriptionWizardState({ status: "available", candidates: selected });
    const onlyFirst = setChineseNameDraft(initial, `US:${overcooked().productUrl}`, "胡闹厨房 2");
    const complete = setChineseNameDraft(onlyFirst, `US:${kirby().productUrl}`, "  星之卡比 探索发现  ");

    expect(canConfirmChineseNames(onlyFirst, selected)).toBe(false);
    expect(canConfirmChineseNames(complete, selected)).toBe(true);
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

  it("automatically adopts a safe regional match and requires an explicit skip for an unresolved region", () => {
    const initial = createSubscriptionWizardState({ status: "available", candidates: [overcooked()] });
    const selected = [overcooked()];
    const selectedKey = `US:${overcooked().productUrl}`;
    const resolutions = [
      { candidateKey: selectedKey, regionCode: "JP" as const, status: "automatic" as const, candidate: overcookedJp() },
      { candidateKey: selectedKey, regionCode: "HK" as const, status: "needs-manual-link" as const, message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" },
    ];
    const automatic = applyAutomaticRegionResolutions(initial, resolutions);

    // 自动匹配仅在服务端已返回唯一安全候选时写入；香港仍必须由管理员核验链接或明确跳过，不能静默遗漏。
    expect(automatic.regionalConfirmations[`${selectedKey}:JP`]).toEqual(overcookedJp());
    expect(automatic).toMatchObject({ regionalConfirmationSources: { [`${selectedKey}:JP`]: "automatic" } });
    expect(canConfirmConfiguredRegions(automatic, selected, resolutions)).toBe(false);

    const skipped = skipRegionalConfirmation(automatic, selectedKey, "HK");
    expect(skipped.skippedRegionalKeys).toEqual([`${selectedKey}:HK`]);
    expect(canConfirmConfiguredRegions(skipped, selected, resolutions)).toBe(true);
  });

  it("turns a manually selected regional candidate into a confirmation and clears its prior skip", () => {
    // 同一地区不能同时提交候选与跳过：管理员点击官方候选卡后，应以 `manual_selection` 取代旧跳过，
    // 让最终载荷完整记录人工审计来源，而不是依赖页面是否刚好显示过某个按钮。
    const selectedKey = `US:${overcooked().productUrl}`;
    const skipped = skipRegionalConfirmation(createSubscriptionWizardState({ status: "available", candidates: [overcooked()] }), selectedKey, "MX");
    const selected = setRegionalCandidate(skipped, selectedKey, "MX", mexicanOvercooked());

    expect(selected.skippedRegionalKeys).not.toContain(`${selectedKey}:MX`);
    expect(selected).toMatchObject({
      regionalConfirmations: { [`${selectedKey}:MX`]: mexicanOvercooked() },
      regionalConfirmationSources: { [`${selectedKey}:MX`]: "manual_selection" },
    });
  });
});

/** 美区《胡闹厨房 2》含常规价，作为促销和当前价显示规则的稳定基线。 */
function overcooked(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "USD", coverUrl: null, currentPriceMinor: 2499, regularPriceMinor: 2499 };
}

/** 第二张美区候选用于验证切换时必须替换当前选择，并触发旧候选上下文的整体清理。 */
function kirby(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/kirby-and-the-forgotten-land-switch/", canonicalTitle: "Kirby and the Forgotten Land", publisher: "Nintendo", productType: "game", currency: "USD", coverUrl: null, currentPriceMinor: 5999, regularPriceMinor: null };
}

/** 香港候选具有独立地区、币种和官方链接，避免状态机依赖美区候选的 URL 或价格。 */
function hongKongKirby(): OfficialProductCandidate {
  return { regionCode: "HK", productUrl: "https://www.nintendo.com/hk/soft/kirby-and-the-forgotten-land/", canonicalTitle: "Kirby and the Forgotten Land", publisher: "Nintendo", productType: "game", currency: "HKD", coverUrl: null, currentPriceMinor: 46800, regularPriceMinor: null };
}

/** 日区候选与美区标题/类型/发行商一致，代表 Node 服务可以安全自动采用的跨区官方映射。 */
function overcookedJp(): OfficialProductCandidate {
  return { regionCode: "JP", productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "JPY", coverUrl: null, currentPriceMinor: 1000, regularPriceMinor: null };
}

/** 墨西哥区候选标题可与默认区不同；点击该官方候选应被标记为人工选择而非系统自动匹配。 */
function mexicanOvercooked(): OfficialProductCandidate {
  return { regionCode: "MX", productUrl: "https://www.nintendo.com/es-mx/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "MXN", coverUrl: null, currentPriceMinor: 24900, regularPriceMinor: null };
}
