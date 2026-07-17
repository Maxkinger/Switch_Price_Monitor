import type { ProductType } from "../worker/providers/types";

/**
 * 前后端共用的核心业务类型。这里集中枚举可持久化的受控值，
 * 避免不同 API、采集器和页面各自拼写字符串而造成历史数据不可查询。
 */
export const priceSources = [
  "official",
  "eshop-prices",
  "nt-deals",
  "deku-deals",
  "green-pipe",
] as const;

/** 价格来源决定可信度和通知规则：只有 official 快照能触发即时降价提醒。 */
export type PriceSource = (typeof priceSources)[number];

/** 首次初始化可选的五个地区；后续扩区必须同时更新采集器与运行时输入校验。 */
export const initialRegionCodes = ["US", "JP", "MX", "BR", "HK"] as const;

/** 地区代码限定为受支持集合，防止把任意字符串写入地区商品或设置记录。 */
export type RegionCode = (typeof initialRegionCodes)[number];

/**
 * 任天堂官方商品发现阶段的瞬时候选。该模型不含数据库 ID、账号状态或外部原始响应，
 * 仅保存管理员选择商品和确认跨区映射所必需的公开身份、封面与已验证价格字段。
 */
export interface OfficialProductCandidate {
  regionCode: RegionCode;
  productUrl: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
  currency: string;
  coverUrl: string | null;
  currentPriceMinor: number | null;
  regularPriceMinor: number | null;
}

/**
 * 官方搜索不可用时必须明确指导管理员改用本区任天堂官方链接，不能返回空候选来伪装“没有搜索结果”。
 * 固定文案也让前端与测试无需根据不稳定的外部错误信息判断是否显示链接输入框。
 */
export type OfficialSearchResult =
  | { status: "available"; candidates: OfficialProductCandidate[] }
  | { status: "unavailable"; message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" };

/**
 * 官方名称检索的最小可注入契约。调用方必须传入地区和取消信号，适配器不能自行扩区或让悬挂外部请求耗尽 Worker 运行时间。
 */
export interface OfficialProductSearch {
  search(regionCode: RegionCode, query: string, signal: AbortSignal): Promise<OfficialSearchResult>;
}

/** 订阅创建前对某地区官方来源的确认结果；前端据此显示官方、第三方回退或不可监控状态。 */
export type SubscriptionPreviewOfficialStatus = "official-available" | "official-id-unavailable";

/**
 * 只返回管理员决定是否创建订阅所需的来源信息，不包含任天堂响应、外部错误正文或任何凭据。
 * fallbackSources 保留实际站点标识，使页面与 Telegram 后续展示能明确标记第三方，而不会伪装为官方价格。
 */
export interface SubscriptionRegionPreview {
  regionCode: RegionCode;
  officialStatus: SubscriptionPreviewOfficialStatus;
  officialPriceId: string | null;
  fallbackSources: Exclude<PriceSource, "official">[];
  canMonitor: boolean;
  message: string;
}

/** 三套已确认主题的稳定标识，持久化时不存储展示文案，便于后续本地化。 */
export const themes = ["warm-card", "calm-dark", "clean-light"] as const;

/** 管理员设置中的主题值。 */
export type Theme = (typeof themes)[number];

/** 首次设置必须同时提交地区集合与默认搜索区；createdAt 用于审计初始化时点。 */
export interface InitialSettings {
  enabledRegions: RegionCode[];
  defaultSearchRegion: RegionCode;
  createdAt: string;
}

/** 完整设置包含 UI、日报与保留策略；敏感 Telegram 配置故意不在该可返回模型中。 */
export interface AppSettings extends InitialSettings {
  theme: Theme;
  timezone: string;
  dailyReportTime: string;
  taxState: string;
  priceHistoryRetention: "forever" | "one-year" | "two-years";
}

/** 创建订阅时前端确认的最小数据；地区商品 ID 必须已由跨区匹配或手动链接校验通过。 */
export interface SubscriptionInput {
  id: string;
  gameId: string;
  regionalProductIds: string[];
  createdAt: string;
}

/** 订阅读取模型补充软停用状态，不删除历史价格以保持长期比较能力。 */
export interface SubscriptionRecord extends SubscriptionInput {
  enabled: boolean;
}

/**
 * 不可变价格快照统一使用最小货币单位与分为单位的人民币，避免浮点误差影响历史最低价和目标价判定。
 * cnyFen 可为空，表示该次本币价格已取得但当日汇率不可用。
 */
export interface PriceSnapshot {
  regionalProductId: string;
  amountMinor: number;
  currency: string;
  cnyFen: number | null;
  source: PriceSource;
  capturedAt: string;
}

/** 历史最低价在快照基础上附带地区，供仪表盘和 Telegram 日报直接展示。 */
export interface HistoricalLow extends PriceSnapshot {
  regionCode: string;
}
