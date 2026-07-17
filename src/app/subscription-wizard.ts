import type {
  OfficialProductCandidate,
  OfficialSearchResult,
  SubscriptionRegionPreview,
} from "../shared/domain";
import type { RegionResolutionResponse } from "./api-client";

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
  /**
   * 已明确跳过的“默认区候选:地区”键。跳过只在本次确认请求中表达管理员决定，
   * 不会伪造地区商品、价格快照或监控关联；Worker 仍以保存设置执行最终覆盖校验。
   */
  skippedRegionalKeys: string[];
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
    skippedRegionalKeys: [],
    sourcePreviews: {},
    submitState: "idle",
  };
}

/**
 * 将服务端唯一匹配的跨区官方候选立即写入确认集合。只有 `automatic` 状态才能自动采用，
 * 人工选择/官方链接状态必须继续等待管理员处理；自动采用同时撤销此前同地区的跳过，避免两个决定并存。
 */
export function applyAutomaticRegionResolutions(
  state: SubscriptionWizardState,
  resolutions: RegionResolutionResponse[],
): SubscriptionWizardState {
  const automatic = resolutions.filter((resolution): resolution is Extract<RegionResolutionResponse, { status: "automatic" }> => resolution.status === "automatic");
  if (automatic.length === 0) return state;
  const confirmationKeys = new Set(automatic.map((resolution) => regionalConfirmationKey(resolution.candidateKey, resolution.regionCode)));
  return {
    ...state,
    regionalConfirmations: {
      ...state.regionalConfirmations,
      ...Object.fromEntries(automatic.map((resolution) => [regionalConfirmationKey(resolution.candidateKey, resolution.regionCode), resolution.candidate])),
    },
    skippedRegionalKeys: state.skippedRegionalKeys.filter((key) => !confirmationKeys.has(key)),
  };
}

/**
 * 切换一个尚未确认地区的显式跳过状态。管理员再次点击会撤销跳过；若该地区已有官方确认，
 * 跳过操作会先移除该确认，保证最终载荷中同一区不会同时作为确认商品和跳过地区出现。
 */
export function skipRegionalConfirmation(
  state: SubscriptionWizardState,
  selectedCandidateKey: string,
  regionCode: OfficialProductCandidate["regionCode"],
): SubscriptionWizardState {
  const key = regionalConfirmationKey(selectedCandidateKey, regionCode);
  const nextSkipped = state.skippedRegionalKeys.includes(key)
    ? state.skippedRegionalKeys.filter((entry) => entry !== key)
    : [...state.skippedRegionalKeys, key];
  const { [key]: _removed, ...regionalConfirmations } = state.regionalConfirmations;
  return { ...state, regionalConfirmations, skippedRegionalKeys: nextSkipped };
}

/**
 * 仅当每个服务端要求处理的跨区状态都已有官方确认或显式跳过时，页面才允许提交。
 * 默认区候选本身由最终确认服务保留；无跨区结果的情况可能是仅启用默认区，页面另行保证已完成解析请求。
 */
export function canConfirmConfiguredRegions(
  state: SubscriptionWizardState,
  selectedCandidates: OfficialProductCandidate[],
  resolutions: RegionResolutionResponse[],
): boolean {
  if (selectedCandidates.length === 0) return false;
  return selectedCandidates.every((selected) => {
    const selectedKey = `${selected.regionCode}:${selected.productUrl}`;
    return resolutions
      .filter((resolution) => resolution.candidateKey === selectedKey)
      .every((resolution) => {
        const key = regionalConfirmationKey(selectedKey, resolution.regionCode);
        return state.regionalConfirmations[key] !== undefined || state.skippedRegionalKeys.includes(key);
      });
  });
}

/**
 * 区分“官方搜索不可用”和“官方搜索成功但没有命中”。后者常见于缺少空格、标点或使用简称，
 * 仍是正常响应；但初次进入页面同样使用空候选模型，所以必须同时确认已提交非空查询，避免误报“未找到”。
 */
export function hasNoOfficialCandidates(searchResult: OfficialSearchResult, submittedQuery: string): boolean {
  return submittedQuery.trim().length > 0 && searchResult.status === "available" && searchResult.candidates.length === 0;
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
