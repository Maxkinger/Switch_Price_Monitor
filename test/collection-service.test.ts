import { describe, expect, it } from "vitest";

import { CollectionService, type PriceSnapshotWriter, type RegionalPriceCollector } from "../src/worker/services/collection-service";
import type { PriceProvider, ProviderResult, RegionalProduct } from "../src/worker/providers/types";

/**
 * 采集服务测试以显式内存端口替代 D1 和网络提供方，验证业务结果而不是某个请求库实现。
 * 真实 Worker 只需把 PriceRepository 与 ProviderChain 接到相同端口，即可继承相同的不可覆盖和过期语义。
 */
describe("CollectionService", () => {
  const product: RegionalProduct = {
    id: "us-overcooked-upgrade",
    regionCode: "US",
    currency: "USD",
    // 该采集服务测试注入的是已验证结果，不模拟地区价格 ID 解析；明确为 null 以防止把测试桩误当作可调用日区接口的映射。
    officialPriceId: null,
    productUrl: "https://example.test/us-overcooked-upgrade",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
  };
  const providers: PriceProvider[] = [];

  it("appends a source-marked immutable snapshot and converts it with the supplied daily rate", async () => {
    // 999 美分按 6.76 CNY/USD 换算为 6753 分；汇率从日级服务传入，采集器不会在每个商品循环中重复请求汇率。
    const snapshots = new MemorySnapshotWriter();
    const service = new CollectionService(new FixedCollector(validResult()), snapshots);

    const outcome = await service.collect({
      product,
      providers,
      rate: { cnyRate: 6.76, isStale: false },
      capturedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(outcome).toMatchObject({ kind: "collected", source: "official", cnyFen: 6_753, isRateStale: false });
    expect(snapshots.items).toEqual([{
      regionalProductId: product.id,
      amountMinor: 999,
      currency: "USD",
      cnyFen: 6_753,
      source: "official",
      capturedAt: "2026-07-16T00:00:00.000Z",
    }]);
  });

  it("keeps the previous price untouched and reports stale data when every provider fails", async () => {
    // 全部来源失败时绝不能新增零价格或覆盖旧快照；仪表盘据此保留最后成功价并标注可能过期。
    const snapshots = new MemorySnapshotWriter();
    const service = new CollectionService(new FixedCollector(null), snapshots);

    await expect(service.collect({ product, providers, rate: { cnyRate: 6.76, isStale: true }, capturedAt: "2026-07-16T00:00:00.000Z" }))
      .resolves.toEqual({ kind: "stale" });
    expect(snapshots.items).toHaveLength(0);
  });

  it("stores the local price even when no usable daily CNY rate is available", async () => {
    // 本币价格和汇率可靠性彼此独立；汇率服务故障不应让日报或本币价格历史完全中断。
    const snapshots = new MemorySnapshotWriter();
    const service = new CollectionService(new FixedCollector(validResult({ source: "nt-deals" })), snapshots);

    await expect(service.collect({ product, providers, rate: null, capturedAt: "2026-07-16T00:00:00.000Z" }))
      .resolves.toMatchObject({ kind: "collected", source: "nt-deals", cnyFen: null, isRateStale: true });
    expect(snapshots.items[0]?.cnyFen).toBeNull();
  });
});

/** 内存写入器记录追加顺序，确保测试能断言服务从不在失败时覆盖或伪造快照。 */
class MemorySnapshotWriter implements PriceSnapshotWriter {
  public readonly items: Parameters<PriceSnapshotWriter["append"]>[0][] = [];

  public async append(snapshot: Parameters<PriceSnapshotWriter["append"]>[0]): Promise<void> {
    this.items.push(snapshot);
  }
}

/** 固定结果采集器模拟已由 ProviderChain 完成的官方优先与身份验证，不重复测试其内部回退逻辑。 */
class FixedCollector implements RegionalPriceCollector {
  public constructor(private readonly result: ProviderResult | null) {}

  public async fetch(): Promise<ProviderResult | null> {
    return this.result;
  }
}

/** 生成已验证商品的标准化结果；需要测试第三方来源时仅覆盖 source，其他身份字段仍保持一致。 */
function validResult(overrides: Partial<ProviderResult> = {}): ProviderResult {
  return {
    source: "official",
    amountMinor: 999,
    currency: "USD",
    title: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
    capturedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}
