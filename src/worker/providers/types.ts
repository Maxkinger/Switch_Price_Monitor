import type { PriceSource, RegionCode } from "../../shared/domain";

/**
 * 采集器内部使用的商品类型比任天堂页面展示分类更稳定。管理员确认商品时写入该值，
 * 每个来源返回结果必须匹配它，才能防止把同名本体、升级包或 DLC 写入同一条历史。
 */
export type ProductType = "game" | "upgrade-pack" | "dlc" | "season-pass" | "bundle" | "other";

/**
 * 已确认的单个地区商品。该模型只含采集所需的公开身份信息，
 * 不携带 Cookie、商店账户或任何访问令牌，确保来源请求可由无状态 Worker 安全执行。
 */
export interface RegionalProduct {
  id: string;
  regionCode: RegionCode;
  currency: string;
  productUrl: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
}

/**
 * 任何来源成功取得的标准化价格。金额必须是最小货币单位，避免小数精度影响跨日最低价比较；
 * source 不可省略，使后续页面标记和“仅官方即时提醒”规则无需猜测数据可靠性。
 */
export interface ProviderResult {
  source: PriceSource;
  amountMinor: number;
  currency: string;
  title: string;
  publisher: string | null;
  productType: ProductType;
  capturedAt: string;
}

/**
 * 具体来源适配器的统一契约。适配器必须尊重 signal，才能在 Worker 的 15 秒上限后真正中止外部请求，
 * 而不是让悬挂连接继续消耗运行时间；返回 null 表示页面可访问但未找到可验证价格。
 */
export interface PriceProvider {
  source: PriceSource;
  fetch(product: RegionalProduct, signal: AbortSignal): Promise<ProviderResult | null>;
}

/**
 * 只有此类错误才允许在同一来源重试一次。解析失败、身份不匹配、HTTP 业务错误等不能重试，
 * 避免对商店和第三方网站制造无意义的额外压力。
 */
export class ProviderNetworkError extends Error {}

/**
 * 每日汇率提供方的最小契约。汇率与价格来源隔离，确保所有地区在同一日报内使用同一批中间价。
 */
export interface ExchangeRateProvider {
  getDailyRates(currencies: string[], signal: AbortSignal): Promise<RateResult[]>;
}

/** 汇率以一单位外币可换得的人民币表示；isStale 由回退逻辑添加，不由外部站点决定。 */
export interface RateResult {
  currency: string;
  cnyRate: number;
  source: string;
  capturedAt: string;
}
