import type {
  OfficialProductCandidate,
  OfficialSearchResult,
  SubscriptionRegionPreview,
} from "../shared/domain";

/** 候选价格的纯显示模型；组件只根据此受控结果排版，不自行猜测原价、促销或折扣。 */
export type CandidatePriceLabel =
  | { kind: "sale"; regularMinor: number; currentMinor: number; discountPercent: number }
  | { kind: "current"; currentMinor: number }
  | { kind: "pending" };

/**
 * 添加订阅向导的纯前端状态。地区确认以“默认区候选键:地区”保存，确保多选游戏在同一地区的商品绝不互相覆盖；
 * 该状态不包含 Cookie、任天堂响应正文或 Telegram 配置，浏览器只保存本次向导所需的公开候选 DTO。
 */
export interface SubscriptionWizardState {
  query: string;
  searchResult: OfficialSearchResult;
  selectedCandidateKeys: string[];
  regionalConfirmations: Record<string, OfficialProductCandidate>;
  sourcePreviews: Record<string, SubscriptionRegionPreview[]>;
  submitState: "idle" | "submitting" | "succeeded" | "failed";
}

/** 为一批官方搜索结果创建干净向导状态；搜索结果不可用时仍保留提示，让页面显示官方链接入口而非伪造空列表。 */
export function createSubscriptionWizardState(searchResult: OfficialSearchResult): SubscriptionWizardState {
  return {
    query: "",
    searchResult,
    selectedCandidateKeys: [],
    regionalConfirmations: {},
    sourcePreviews: {},
    submitState: "idle",
  };
}

/**
 * 点击整张候选卡时只切换该候选键。数组保留用户点击顺序，既便于批量确认按可预期顺序展示，
 * 也避免单选逻辑在用户选择第二款游戏时意外清掉第一款游戏。
 */
export function toggleCandidate(state: SubscriptionWizardState, candidateKey: string): SubscriptionWizardState {
  const selectedCandidateKeys = state.selectedCandidateKeys.includes(candidateKey)
    ? state.selectedCandidateKeys.filter((key) => key !== candidateKey)
    : [...state.selectedCandidateKeys, candidateKey];
  return { ...state, selectedCandidateKeys };
}

/**
 * 将一个地区商品绑定到指定默认区游戏。键必须带上默认区候选而不是仅用地区代码，
 * 因为同时订阅两款游戏时它们都可以拥有香港区映射，单独使用 `HK` 会导致后一项覆盖前一项。
 */
export function setRegionalCandidate(
  state: SubscriptionWizardState,
  selectedCandidateKey: string,
  regionCode: OfficialProductCandidate["regionCode"],
  candidate: OfficialProductCandidate,
): SubscriptionWizardState {
  return {
    ...state,
    regionalConfirmations: {
      ...state.regionalConfirmations,
      [regionalConfirmationKey(selectedCandidateKey, regionCode)]: candidate,
    },
  };
}

/** 已验证促销必须同时存在原价与更低当前价；相等、反向或缺失值都不显示折扣，防止把不可靠数据视觉放大。 */
export function candidatePriceLabel(candidate: OfficialProductCandidate): CandidatePriceLabel {
  if (candidate.currentPriceMinor === null) return { kind: "pending" };
  if (candidate.regularPriceMinor !== null && candidate.currentPriceMinor < candidate.regularPriceMinor) {
    return {
      kind: "sale",
      regularMinor: candidate.regularPriceMinor,
      currentMinor: candidate.currentPriceMinor,
      discountPercent: Math.round((1 - candidate.currentPriceMinor / candidate.regularPriceMinor) * 100),
    };
  }
  return { kind: "current", currentMinor: candidate.currentPriceMinor };
}

/** 地区确认键是内部 UI 识别符，不会送往 API；官方链接仍是服务端重新验证的唯一身份依据。 */
export function regionalConfirmationKey(selectedCandidateKey: string, regionCode: OfficialProductCandidate["regionCode"]): string {
  return `${selectedCandidateKey}:${regionCode}`;
}
