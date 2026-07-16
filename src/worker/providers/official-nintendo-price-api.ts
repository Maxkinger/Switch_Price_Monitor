import { ProviderNetworkError, type PriceProvider, type ProviderResult, type RegionalProduct } from "./types";

/**
 * 从任天堂日区公开价格 API 读取已确认地区商品的价格。该接口不返回完整的标题、发行商或商品类型，
 * 因此本适配器只接受添加流程已验证的 JP/JPY/价格 ID 映射，并把这些受控身份字段带回来源链做二次校验。
 */
export function createNintendoPriceApiProvider(fetchPrice: typeof fetch = fetch): PriceProvider {
  return {
    source: "official",
    async fetch(product, signal) {
      // 当前 ADR 只验证了日区公开接口；缺 ID、非日区或非日元商品必须让来源链继续尝试第三方，绝不猜测跨区价格。
      if (product.regionCode !== "JP" || product.currency !== "JPY" || product.officialPriceId === null) return null;

      const url = new URL("https://api.ec.nintendo.com/v1/price");
      url.search = new URLSearchParams({ country: "JP", ids: product.officialPriceId, lang: "ja" }).toString();

      let response: Response;
      try {
        response = await fetchPrice(url, { headers: { accept: "application/json" }, signal });
      } catch (error) {
        // 网络层失败允许 ProviderChain 重试一次；JSON 内容或商品状态错误没有重试价值，也不应加重任天堂负载。
        throw new ProviderNetworkError(error instanceof Error ? error.message : "Nintendo Japanese price API request failed");
      }
      if (!response.ok) return null;

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // 公开接口返回非 JSON 时无法安全推断价格，交由后续来源回退而不是抛出解析细节到日志或前端。
        return null;
      }
      return parseJapanesePrice(payload, product);
    },
  };
}

/**
 * 严格校验任天堂价格响应的地区、标题 ID、在售状态、币种与整数金额。该 API 不提供完整商品身份，
 * 标题/发行商/类型只能来自已确认的地区商品映射，不能从响应缺失字段中填补或猜测。
 */
function parseJapanesePrice(payload: unknown, product: RegionalProduct): ProviderResult | null {
  if (!isRecord(payload) || payload.country !== "JP" || !Array.isArray(payload.prices) || product.officialPriceId === null) return null;
  const price = payload.prices.find((entry) => isRecord(entry) && String(entry.title_id) === product.officialPriceId);
  if (!price || price.sales_status !== "onsale" || !isRecord(price.regular_price)) return null;

  const currency = price.regular_price.currency;
  const rawValue = price.regular_price.raw_value;
  const amountMinor = typeof rawValue === "string" && /^\d+$/.test(rawValue) ? Number(rawValue) : Number.NaN;
  // 日元没有小数位；仅接受非负安全整数，避免异常字符串、浮点数或溢出金额进入不可变历史。
  if (currency !== "JPY" || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return null;

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
