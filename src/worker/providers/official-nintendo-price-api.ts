import type { RegionCode } from "../../shared/domain";
import { ProviderNetworkError, type PriceProvider, type RegionalProduct } from "./types";

/**
 * 任天堂公开价格 API 的已审核地区档案。国家、语言和货币只能由 Worker 内的固定档案决定，
 * 不能从浏览器、地区商品 URL 或 API 响应推导，避免把跨服价格写入不可变历史。
 */
interface NintendoPriceApiProfile {
  country: "JP" | "HK";
  language: "ja" | "zh";
  currency: "JPY" | "HKD";
}

/**
 * 目前仅日区和香港区的公开价格 API 已通过 ADR-002 准入验证。新增地区必须先验证其公开接口、
 * 货币、商品 ID 规则和使用边界，不能因接口形状相似而直接复用本表。
 */
const priceApiProfiles: Partial<Record<RegionCode, NintendoPriceApiProfile>> = {
  JP: { country: "JP", language: "ja", currency: "JPY" },
  HK: { country: "HK", language: "zh", currency: "HKD" },
};

/**
 * 经过官方响应结构与地区身份双重校验后的报价。金额统一为系统写入快照时使用的最小货币单位：
 * 日元按 1、港元按 100 转换；`regularPriceMinor` 只在真实折扣严格低于常规价时保留，避免将异常字段解释为促销。
 */
export interface NintendoOfficialPriceQuote {
  officialPriceId: string;
  currency: "JPY" | "HKD";
  currentPriceMinor: number;
  regularPriceMinor: number | null;
}

/**
 * 独立的官方报价解析边界，供价格快照与日区升级包关系复核共享。调用方只能传入已确认的地区价格 ID，
 * 因为任天堂价格 API 不提供可替代的完整商品身份，解析器绝不通过标题或折扣金额推断商品归属。
 */
export interface NintendoOfficialPriceQuoteResolver {
  resolve(regionCode: RegionCode, currency: string, officialPriceId: string, signal: AbortSignal): Promise<NintendoOfficialPriceQuote | null>;
}

/**
 * 创建任天堂公开价格报价解析器。只允许 Worker 固定的 JP/HK 档案构造 URL，并将传输层故障转换为可重试错误；
 * 非 2xx、非 JSON 或结构不可信的响应均返回 null，使上层安全回退而不会因格式异常重复请求官方接口。
 */
export function createNintendoOfficialPriceQuoteResolver(fetchPrice: typeof fetch = fetch): NintendoOfficialPriceQuoteResolver {
  return {
    async resolve(regionCode, currency, officialPriceId, signal) {
      const profile = priceApiProfiles[regionCode];
      // 地区、币种和纯数字官方 ID 是跨服价格隔离的最小证据；任一缺失时不发网路请求，避免错误 ID 污染历史报价。
      if (!profile || profile.currency !== currency || !/^\d+$/.test(officialPriceId)) return null;

      const url = new URL("https://api.ec.nintendo.com/v1/price");
      url.search = new URLSearchParams({ country: profile.country, ids: officialPriceId, lang: profile.language }).toString();

      let response: Response;
      try {
        response = await fetchPrice(url, { headers: { accept: "application/json" }, signal });
      } catch (error) {
        // fetch 调用的任意拒绝统一封装为可重试错误；不读取或透传外部响应正文，防止网络实现细节进入日志或前端。
        if (error instanceof ProviderNetworkError) throw error;
        throw new ProviderNetworkError(error instanceof Error ? error.message : "Nintendo official price API request failed");
      }
      if (!response.ok) return null;

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // HTTP 成功但内容非 JSON 仍属于不可验证的业务响应，不应误判为网络故障并增加任天堂接口负载。
        return null;
      }
      return parseNintendoPriceQuote(payload, officialPriceId, profile);
    },
  };
}

/**
 * 从任天堂已准入地区的公开价格 API 读取已确认地区商品的价格。该接口不返回完整的标题、发行商或商品类型，
 * 因此本适配器只接受添加流程已验证的本区价格 ID 映射，并把这些受控身份字段带回来源链做二次校验。
 */
export function createNintendoPriceApiProvider(fetchPrice: typeof fetch = fetch): PriceProvider {
  const quoteResolver = createNintendoOfficialPriceQuoteResolver(fetchPrice);

  return {
    source: "official",
    async fetch(product, signal) {
      // 未确认价格 ID 时没有可安全请求的官方身份；其余 URL、响应校验与网络重试语义全部委托同一报价解析器，防止两条路径漂移。
      if (product.officialPriceId === null) return null;
      const quote = await quoteResolver.resolve(product.regionCode, product.currency, product.officialPriceId, signal);
      if (!quote) return null;

      return {
        source: "official",
        amountMinor: quote.currentPriceMinor,
        currency: quote.currency,
        officialPriceId: quote.officialPriceId,
        // API 缺少完整身份，快照只能回填管理员确认的本区字段，不能信任或猜测外部标题、发行商和商品类别。
        title: product.canonicalTitle,
        publisher: product.publisher,
        productType: product.productType,
        capturedAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * 严格校验任天堂价格响应的地区、标题 ID、在售状态、币种与整数金额。常规价始终是当前价的可验证基础；
 * 只有结构完整且严格低于常规价的折扣才覆盖当前价并返回常规价，防止畸形外部响应被伪造成免费或降价。
 */
function parseNintendoPriceQuote(payload: unknown, officialPriceId: string, profile: NintendoPriceApiProfile): NintendoOfficialPriceQuote | null {
  if (!isRecord(payload) || payload.country !== profile.country || !Array.isArray(payload.prices)) return null;
  const price = payload.prices.find((entry) => isRecord(entry) && readNintendoTitleId(entry.title_id) === officialPriceId);
  if (!price || price.sales_status !== "onsale") return null;

  const regularPriceMinor = readNintendoMinorPrice(price.regular_price, profile.currency);
  if (regularPriceMinor === null) return null;

  // 无折扣字段时当前可购价就是经验证的常规价，但不把它误报为“原价”；其他非对象折扣值是外部结构错误，必须失败闭合。
  if (price.discount_price === undefined || price.discount_price === null) {
    return { officialPriceId, currency: profile.currency, currentPriceMinor: regularPriceMinor, regularPriceMinor: null };
  }

  const discountPriceMinor = readNintendoMinorPrice(price.discount_price, profile.currency);
  // 折扣与常规价相等、倒挂或金额字段畸形均不能代表有效促销，不能退回常规价以掩盖该异常。
  if (discountPriceMinor === null || discountPriceMinor >= regularPriceMinor) return null;

  return {
    officialPriceId,
    currency: profile.currency,
    currentPriceMinor: discountPriceMinor,
    regularPriceMinor,
  };
}

/**
 * 将任天堂 `raw_value` 规范化为系统最小货币单位。公开 API 的日元是整日元、港元是整港元而非分，
 * 因此只对已准入的 HKD 使用 100 倍；严格整数、匹配币种与安全范围校验阻止浮点、溢出或串区金额进入历史。
 */
function readNintendoMinorPrice(value: unknown, expectedCurrency: NintendoPriceApiProfile["currency"]): number | null {
  if (!isRecord(value) || typeof value.currency !== "string" || value.currency !== expectedCurrency) return null;
  if (typeof value.raw_value !== "string" || !/^\d+$/.test(value.raw_value)) return null;

  const rawAmount = Number(value.raw_value);
  /**
   * 任天堂公开接口的 raw_value 不是统一的最小货币单位：JPY 是整日元，HKD 是整港元。
   * 快照、汇率和历史最低价则统一使用最小单位，所以只允许已审核币种按明确倍率转换，避免人民币估算少两个数量级。
   */
  const minorFactor = expectedCurrency === "HKD" ? 100 : 1;
  const amountMinor = rawAmount * minorFactor;
  // 非负安全整数是快照持久化、历史最低价比较和价格提醒计算的共同边界；不合法时绝不能补成零价。
  return Number.isSafeInteger(amountMinor) && amountMinor >= 0 ? amountMinor : null;
}

/**
 * 规范化响应中的标题 ID，但只接受原始安全非负整数或纯数字字符串。数组、对象、布尔值与 null 即使可被
 * JavaScript 隐式转成相同文本也必须拒绝，避免宽松字符串化让非官方结构绕过本区已确认价格 ID 的身份边界。
 */
function readNintendoTitleId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

/** 仅让普通 JSON 对象进入公开响应字段读取，避免数组、null 或原型对象绕过结构校验。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
