import type { AppSettings, RegionCode } from "../shared/domain";

/**
 * 设置页面可提交的公开字段。初始化时间只用于服务端审计，绝不能随着浏览器草稿再次写入；
 * Telegram、认证和第三方来源均不属于此模型，避免未来页面扩展时意外形成秘密输入通道。
 */
export interface PublicSettingsPatch {
  enabledRegions: RegionCode[];
  defaultSearchRegion: RegionCode;
  theme: AppSettings["theme"];
  timezone: string;
  dailyReportTime: string;
  taxState: string;
  priceHistoryRetention: AppSettings["priceHistoryRetention"];
}

/** 受控表单状态与公开 PATCH 同形，便于一次保存且不会把 API 返回的 createdAt 滞留在 React 内存。 */
export type SettingsFormState = PublicSettingsPatch;

/**
 * 从 Worker 的完整公开 DTO 建立浏览器草稿。地区数组必须复制，防止复选框更新意外修改先前响应对象；
 * 其他字段是原始值，只用于当前页面展示和下一次 PATCH，不代表 Cookie、会话或秘密配置。
 */
export function createSettingsForm(settings: AppSettings): SettingsFormState {
  return {
    enabledRegions: [...settings.enabledRegions],
    defaultSearchRegion: settings.defaultSearchRegion,
    theme: settings.theme,
    timezone: settings.timezone,
    dailyReportTime: settings.dailyReportTime,
    taxState: settings.taxState,
    priceHistoryRetention: settings.priceHistoryRetention,
  };
}

/**
 * 切换一个受支持地区并保持默认搜索区可用。最后一个地区不能取消，防止页面产生空监控范围；
 * Worker 会在保存时再次验证，前端联动仅用于即时且可理解的交互反馈。
 */
export function toggleSettingsRegion(state: SettingsFormState, regionCode: RegionCode): SettingsFormState {
  if (state.enabledRegions.length === 1 && state.enabledRegions[0] === regionCode) return state;
  const enabledRegions = state.enabledRegions.includes(regionCode)
    ? state.enabledRegions.filter((item) => item !== regionCode)
    : [...state.enabledRegions, regionCode];
  return {
    ...state,
    enabledRegions,
    defaultSearchRegion: enabledRegions.includes(state.defaultSearchRegion) ? state.defaultSearchRegion : enabledRegions[0],
  };
}

/**
 * 默认搜索区只能选择当前已启用地区。异常或过期控件传来的地区代码保持原草稿，
 * 避免浏览器在服务端拒绝前已经显示无法执行的默认区。
 */
export function setSettingsDefaultRegion(state: SettingsFormState, regionCode: RegionCode): SettingsFormState {
  return state.enabledRegions.includes(regionCode) ? { ...state, defaultSearchRegion: regionCode } : state;
}

/**
 * 显式构造 PATCH 白名单，防止 `createdAt`、认证状态或未来 Telegram 字段因对象展开被提交。
 * 该函数不做 Worker 校验；页面提交后仍以服务端的地区、时区、时间和税务州规则为准。
 */
export function toPublicSettingsPatch(state: SettingsFormState): PublicSettingsPatch {
  return {
    enabledRegions: [...state.enabledRegions],
    defaultSearchRegion: state.defaultSearchRegion,
    theme: state.theme,
    timezone: state.timezone,
    dailyReportTime: state.dailyReportTime,
    taxState: state.taxState,
    priceHistoryRetention: state.priceHistoryRetention,
  };
}
