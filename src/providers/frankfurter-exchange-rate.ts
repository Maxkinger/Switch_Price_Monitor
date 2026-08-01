import { ProviderNetworkError, type ExchangeRateProvider, type RateResult } from "./types";

/** Frankfurter v2 的公开响应只读取这一组字段，避免外部新增字段意外进入汇率存储或 API 返回。 */
interface FrankfurterRate {
  date: string;
  base: string;
  quote: string;
  rate: number;
}

/**
 * 构造不需密钥的 Frankfurter 汇率提供方。请求以 CNY 为基准，随后取倒数得到“一单位外币对应多少人民币”，
 * 使采集服务可直接把五区本币最小金额换算为人民币分，而无需在每个商品循环重复换算方向。
 */
export function createFrankfurterExchangeRateProvider(fetchRates: typeof fetch = fetch): ExchangeRateProvider {
  return {
    async getDailyRates(currencies, signal) {
      const requested = [...new Set(currencies)].filter((currency) => currency !== "CNY");
      if (requested.length === 0) return [];

      const url = new URL("https://api.frankfurter.dev/v2/rates");
      url.search = new URLSearchParams({ base: "CNY", quotes: requested.join(",") }).toString();

      let response: Response;
      try {
        response = await fetchRates(url, { headers: { accept: "application/json" }, signal });
      } catch (error) {
        // 传输失败交给来源链执行一次统一重试；解析或业务状态失败不重试，避免对公共汇率服务形成无意义压力。
        throw new ProviderNetworkError(error instanceof Error ? error.message : "Frankfurter exchange-rate request failed");
      }
      if (!response.ok) return [];

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // 非 JSON 响应无法安全计算汇率；返回空数组让上层仅对已有历史值采用过期回退。
        return [];
      }
      return parseFrankfurterRates(payload, new Set(requested));
    },
  };
}

/**
 * 仅接受 CNY 基准、请求币种、正有限数值和 ISO 日期。倒数会先限制精度，
 * 避免二进制浮点的微小尾差影响测试、快照比较或页面中人民币估算的一致性。
 */
function parseFrankfurterRates(payload: unknown, requested: Set<string>): RateResult[] {
  if (!Array.isArray(payload)) return [];
  const values: RateResult[] = [];
  for (const entry of payload) {
    if (!isFrankfurterRate(entry) || entry.base !== "CNY" || !requested.has(entry.quote) || entry.rate <= 0) continue;
    const cnyRate = roundRate(1 / entry.rate);
    if (!Number.isFinite(cnyRate) || cnyRate <= 0) continue;
    values.push({
      currency: entry.quote,
      cnyRate,
      source: "frankfurter",
      capturedAt: `${entry.date}T00:00:00.000Z`,
    });
  }
  return values;
}

/** 不让外部 JSON 的对象、空值或类型错误绕过运行时校验；所有字段在进入业务逻辑前必须明确存在。 */
function isFrankfurterRate(value: unknown): value is FrankfurterRate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
    && typeof record.base === "string"
    && typeof record.quote === "string"
    && typeof record.rate === "number"
    && Number.isFinite(record.rate);
}

/** 汇率保留十位小数足以覆盖五区人民币换算，同时消除倒数运算的无业务意义浮点尾差。 */
function roundRate(value: number): number {
  return Math.round(value * 10_000_000_000) / 10_000_000_000;
}
