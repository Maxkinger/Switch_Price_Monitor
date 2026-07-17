import type { ExchangeRateProvider, RateResult } from "../providers/types";
import type { DailyCnyRate } from "./collection-service";

/** 汇率存储端口使服务可由真实 D1 或内存夹具驱动，并限制它只能写入成功值和读取最近历史。 */
export interface ExchangeRateStore {
  append(value: RateResult): Promise<void>;
  latestFor(currency: string): Promise<RateResult | null>;
}

/**
 * 每个采集批次只调用一次的人民币汇率服务。它优先保存本轮可验证的外部结果，
 * 对缺失或请求失败币种才回退最近成功值并标为过期，确保本币价格不会因汇率短暂故障而中断。
 */
export class DailyCnyRateService {
  public constructor(
    private readonly provider: ExchangeRateProvider,
    private readonly store: ExchangeRateStore,
  ) {}

  /**
   * 返回按币种索引的本轮汇率。参数 `now` 保留为运行器的统一时钟边界，
   * 当前来源自带交易日期；以后更换来源时不能改为使用浏览器时间或逐商品时间。
   */
  public async get(currencies: string[], _now: string): Promise<Map<string, DailyCnyRate>> {
    const requested = [...new Set(currencies)].filter((currency) => currency !== "CNY");
    let fresh: RateResult[] = [];
    try {
      fresh = await this.provider.getDailyRates(requested, new AbortController().signal);
    } catch {
      // 错误摘要由采集日志层记录；汇率服务不传播外部正文，避免使某一汇率失败终止整轮商品采集。
      fresh = [];
    }

    const freshByCurrency = new Map(fresh.filter((value) => requested.includes(value.currency)).map((value) => [value.currency, value]));
    const result = new Map<string, DailyCnyRate>();
    for (const currency of requested) {
      const current = freshByCurrency.get(currency);
      if (current) {
        await this.store.append(current);
        result.set(currency, { cnyRate: current.cnyRate, isStale: false });
        continue;
      }

      const previous = await this.store.latestFor(currency);
      if (previous) result.set(currency, { cnyRate: previous.cnyRate, isStale: true });
    }
    return result;
  }
}
