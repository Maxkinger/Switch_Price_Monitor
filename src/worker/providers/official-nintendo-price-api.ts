import { ProviderNetworkError, type PriceProvider, type ProviderResult, type RegionalProduct } from "./types";

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
const priceApiProfiles: Partial<Record<RegionalProduct["regionCode"], NintendoPriceApiProfile>> = {
  JP: { country: "JP", language: "ja", currency: "JPY" },
  HK: { country: "HK", language: "zh", currency: "HKD" },
};

/**
 * 从任天堂已准入地区的公开价格 API 读取已确认地区商品的价格。该接口不返回完整的标题、发行商或商品类型，
 * 因此本适配器只接受添加流程已验证的本区价格 ID 映射，并把这些受控身份字段带回来源链做二次校验。
 */
export function createNintendoPriceApiProvider(fetchPrice: typeof fetch = fetch): PriceProvider {
  return {
    source: "official",
    async fetch(product, signal) {
      const profile = priceApiProfiles[product.regionCode];
      // 缺少已审核地区档案、币种不符或未确认 ID 时绝不请求接口，让来源链按既有顺序安全回退而非猜测跨区价格。
      if (!profile || product.currency !== profile.currency || product.officialPriceId === null) return null;

      const url = new URL("https://api.ec.nintendo.com/v1/price");
      url.search = new URLSearchParams({ country: profile.country, ids: product.officialPriceId, lang: profile.language }).toString();

      let response: Response;
      try {
        response = await fetchPrice(url, { headers: { accept: "application/json" }, signal });
      } catch (error) {
        // 网络层失败允许 ProviderChain 重试一次；JSON 内容或商品状态错误没有重试价值，也不应加重任天堂负载。
        throw new ProviderNetworkError(error instanceof Error ? error.message : "Nintendo official price API request failed");
      }
      if (!response.ok) return null;

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // 公开接口返回非 JSON 时无法安全推断价格，交由后续来源回退而不是抛出解析细节到日志或前端。
        return null;
      }
      return parseNintendoPrice(payload, product, profile);
    },
  };
}

/**
 * 严格校验任天堂价格响应的地区、标题 ID、在售状态、币种与整数金额。促销存在时只采集实际可购买的折后价；
 * 该 API 不提供完整商品身份，
 * 标题/发行商/类型只能来自已确认的地区商品映射，不能从响应缺失字段中填补或猜测。
 */
function parseNintendoPrice(payload: unknown, product: RegionalProduct, profile: NintendoPriceApiProfile): ProviderResult | null {
  if (!isRecord(payload) || payload.country !== profile.country || !Array.isArray(payload.prices) || product.officialPriceId === null) return null;
  const price = payload.prices.find((entry) => isRecord(entry) && String(entry.title_id) === product.officialPriceId);
  if (!price || price.sales_status !== "onsale") return null;

  // `discount_price` 为对象即表示任天堂提供了当前促销售价；null/缺失时才回落到常规价，不能把异常折扣字段当成常规价格接受。
  const currentPrice = isRecord(price.discount_price) ? price.discount_price : price.regular_price;
  if (!isRecord(currentPrice)) return null;
  const currency = currentPrice.currency;
  const rawValue = currentPrice.raw_value;
  const amountMinor = typeof rawValue === "string" && /^\d+$/.test(rawValue) ? Number(rawValue) : Number.NaN;
  // API 的 raw_value 已按货币最小单位给出；先确认外部币种字段为字符串，再接受本区受控币种与非负安全整数，避免对象、浮点、异常字符串或溢出金额进入不可变历史。
  if (typeof currency !== "string" || currency !== profile.currency || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return null;

  return {
    source: "official",
    amountMinor,
    currency,
    officialPriceId: product.officialPriceId,
    title: product.canonicalTitle,
    publisher: product.publisher,
    productType: product.productType,
    capturedAt: new Date().toISOString(),
  };
}

/** 仅让普通 JSON 对象进入公开响应字段读取，避免数组、null 或原型对象绕过结构校验。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
