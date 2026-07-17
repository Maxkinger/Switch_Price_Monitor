import { describe, expect, it } from "vitest";

import type { RateResult } from "../src/worker/providers/types";
import { DailyCnyRateService, type ExchangeRateStore } from "../src/worker/services/daily-cny-rate-service";

describe("DailyCnyRateService", () => {
  it("stores current CNY rates returned for every requested currency", async () => {
    // 一次采集批次中的 USD 与 JPY 必须使用同一轮来源结果；服务将其写入存储后返回非过期状态给所有地区商品复用。
    const store = new MemoryExchangeRateStore();
    const service = new DailyCnyRateService(new FixedRateProvider([
      rate("USD", 6.8),
      rate("JPY", 0.043),
    ]), store);

    await expect(service.get(["USD", "JPY"], "2026-07-17T00:00:00.000Z")).resolves.toEqual(new Map([
      ["USD", { cnyRate: 6.8, isStale: false }],
      ["JPY", { cnyRate: 0.043, isStale: false }],
    ]));
    expect(store.appended.map((item) => item.currency)).toEqual(["USD", "JPY"]);
  });

  it("reuses only the latest stored rate and labels it stale when the provider fails", async () => {
    // 汇率服务故障不能阻断本币价格采集，但旧值必须被显式标记为过期，防止 UI 把它误展示为当日中间价。
    const store = new MemoryExchangeRateStore(new Map([["USD", rate("USD", 6.7)]]));
    const service = new DailyCnyRateService(new FailingRateProvider(), store);

    await expect(service.get(["USD", "JPY"], "2026-07-17T00:00:00.000Z")).resolves.toEqual(new Map([
      ["USD", { cnyRate: 6.7, isStale: true }],
    ]));
  });
});

/** 内存仓储仅保存服务契约中的最新汇率，避免该业务测试依赖 D1 迁移而失去失败场景的可读性。 */
class MemoryExchangeRateStore implements ExchangeRateStore {
  public readonly appended: RateResult[] = [];

  public constructor(private readonly latest = new Map<string, RateResult>()) {}

  public async append(value: RateResult): Promise<void> {
    this.appended.push(value);
    this.latest.set(value.currency, value);
  }

  public async latestFor(currency: string): Promise<RateResult | null> {
    return this.latest.get(currency) ?? null;
  }
}

/** 固定提供方模拟已通过外部结构校验的单日来源响应，使测试聚焦当前轮写入和回退语义。 */
class FixedRateProvider {
  public constructor(private readonly values: RateResult[]) {}

  public async getDailyRates(): Promise<RateResult[]> {
    return this.values;
  }
}

/** 故障提供方模拟网络异常；服务不读取错误正文，也不让异常阻断其它价格采集步骤。 */
class FailingRateProvider {
  public async getDailyRates(): Promise<RateResult[]> {
    throw new Error("exchange service unavailable");
  }
}

/** 生成精确且可追溯的汇率夹具；金额为一外币单位对应的人民币，不涉及价格金额换算。 */
function rate(currency: string, cnyRate: number): RateResult {
  return { currency, cnyRate, source: "frankfurter", capturedAt: "2026-07-17T00:00:00.000Z" };
}
