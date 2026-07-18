import { DashboardApiError, type CompletedRefreshResult } from "./dashboard-api-client";
import type { ConfirmedRegionalProduct } from "../shared/domain";
import type { RegionResolutionResponse } from "./api-client";

/**
 * 详情页在内存中保留的目标价草稿。金额继续使用 Worker 的最小货币单位，
 * 以免浏览器输入格式化和服务端阈值比较之间出现浮点精度差异。
 */
export interface DetailTargetDraft {
  globalTargetCnyFen: number | null;
  regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>;
}

/**
 * 详情请求失败后的最小状态。401 使用独立状态而不携带原状态，
 * 让应用壳层能立即卸载所有订阅、价格、地区和目标价等管理员私有数据。
 */
export type DetailRequestState =
  | { kind: "ready"; targetDraft: DetailTargetDraft; error: string | null }
  | { kind: "unauthorized" };

/** 初始草稿没有阈值；详情加载完成时由 Worker DTO 覆盖，避免页面自行填入默认金额。 */
export const initialDetailState: DetailRequestState = {
  kind: "ready",
  targetDraft: { globalTargetCnyFen: null, regionTargets: [] },
  error: null,
};

/**
 * 将请求错误映射为页面行为。422 等表单错误保留原草稿供管理员修正；
 * 401 则必须丢弃原状态并通知外层安全登出，不能让旧价格在登录表单后继续留在内存。
 */
export function applyDetailRequestFailure(state: DetailRequestState, error: DashboardApiError): DetailRequestState {
  if (error.status === 401) return { kind: "unauthorized" };
  if (state.kind === "unauthorized") return state;
  return { ...state, error: error.message };
}

/**
 * 手动刷新只在服务端统一采集结束后返回 completed。浏览器仅展示聚合计数，
 * 实际价格、来源、历史最低价和过期判断必须由页面随后重新读取 Worker 仪表盘获取。
 */
export function immediateRefreshNotice(result: CompletedRefreshResult): string {
  return `已完成本次采集：成功 ${result.collected} 个地区，待确认 ${result.stale} 个地区。`;
}

/** 详情页只呈现三种由 Worker 返回的地区状态，不能由浏览器根据数组长度、标题或价格自行猜测。 */
export type MissingRegionPresentation = "automatic-readonly" | "candidate-list" | "link-input";

/** 只有 `needs-manual-link` 可显示链接输入，避免已有官方候选时诱导管理员绕过候选选择。 */
export function missingRegionPresentation(status: RegionResolutionResponse["status"]): MissingRegionPresentation {
  if (status === "automatic") return "automatic-readonly";
  if (status === "needs-manual-selection") return "candidate-list";
  return "link-input";
}

/**
 * 唯一严格匹配在详情页打开后直接成为补全草稿，但绝不触发写入；管理员仍须点击“确认补全”。
 * 本地化候选和链接兜底刻意不加入草稿，防止浏览器误把非唯一官方结果自动加入监控。
 */
export function applyAutomaticMissingResolutions(
  resolutions: RegionResolutionResponse[],
): Record<string, ConfirmedRegionalProduct> {
  return Object.fromEntries(
    resolutions
      .filter((resolution): resolution is Extract<RegionResolutionResponse, { status: "automatic" }> => resolution.status === "automatic")
      .map((resolution) => [resolution.regionCode, { ...resolution.candidate, matchSource: "automatic" }]),
  );
}
