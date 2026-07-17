import { describe, expect, it, vi } from "vitest";

import type { DailyCnyRate } from "../src/worker/services/collection-service";
import { LiveCollectionRunner } from "../src/worker/services/live-collection-runner";
import type { RegionalProduct } from "../src/worker/providers/types";

/** 两区夹具分别模拟一条可采集商品与一条官方来源全部失败商品，验证单项失败不会中止整个批次。 */
const products: RegionalProduct[] = [
  { id: "product-jp", regionCode: "JP", currency: "JPY", officialPriceId: "70050000064985", productUrl: "https://example.test/jp", canonicalTitle: "Game JP", publisher: "Publisher", productType: "game" },
  { id: "product-hk", regionCode: "HK", currency: "HKD", officialPriceId: null, productUrl: "https://example.test/hk", canonicalTitle: "Game HK", publisher: "Publisher", productType: "game" },
];

describe("LiveCollectionRunner", () => {
  it("collects every enabled product and records health independently when one region is stale", async () => {
    // 同一轮必须对所有启用地区继续执行；HK 的失败仅更新它自己的健康状态，不能阻止 JP 写入快照或发送后续通知。
    const collection = { collect: vi.fn()
      .mockResolvedValueOnce({ kind: "collected", source: "official", cnyFen: 5000, isRateStale: false })
      .mockResolvedValueOnce({ kind: "stale" }) };
    const health = { record: vi.fn().mockResolvedValue({ notification: "none" }) };
    const runner = new LiveCollectionRunner({
      products: { enabledRegionalProducts: async () => products },
      rates: { get: async (): Promise<Map<string, DailyCnyRate>> => new Map([["JPY", { cnyRate: 0.043, isStale: false }], ["HKD", { cnyRate: 0.9, isStale: false }]]) },
      officialProviders: { providersFor: () => [] },
      collection,
      health,
    });

    await expect(runner.run("2026-07-17T00:00:00.000Z")).resolves.toEqual({ attempted: 2, collected: 1, stale: 1 });
    expect(collection.collect).toHaveBeenNthCalledWith(1, expect.objectContaining({ product: products[0], rate: { cnyRate: 0.043, isStale: false } }));
    expect(collection.collect).toHaveBeenNthCalledWith(2, expect.objectContaining({ product: products[1], rate: { cnyRate: 0.9, isStale: false } }));
    expect(health.record).toHaveBeenNthCalledWith(1, "product-jp", true, "2026-07-17T00:00:00.000Z");
    expect(health.record).toHaveBeenNthCalledWith(2, "product-hk", false, "2026-07-17T00:00:00.000Z");
  });

  it("reserves one immediate event only when a new official price is lower than the prior official snapshot", async () => {
    // 第三方来源或首次官方价格都没有可比的前一官方快照，不能据此触发提醒；此处固定一条更高的前值来验证真实降价路径。
    const events = { reserve: vi.fn().mockResolvedValue(true) };
    const runner = new LiveCollectionRunner({
      products: { enabledRegionalProducts: async () => [products[0]!] },
      rates: { get: async (): Promise<Map<string, DailyCnyRate>> => new Map([["JPY", { cnyRate: 0.043, isStale: false }]]) },
      officialProviders: { providersFor: () => [] },
      collection: { collect: vi.fn().mockResolvedValue({ kind: "collected", source: "official", amountMinor: 800, cnyFen: 34, isRateStale: false }) },
      health: { record: vi.fn().mockResolvedValue({ notification: "none" }) },
      previousOfficial: { latestOfficialFor: vi.fn().mockResolvedValue({ amountMinor: 1000, source: "official" }) },
      events,
    });

    await runner.run("2026-07-17T00:00:00.000Z");

    expect(events.reserve).toHaveBeenCalledWith(expect.objectContaining({
      regionalProductId: "product-jp",
      eventType: "official-price-drop",
      dedupeKey: "product-jp:official-price-drop:2026-07-17T00:00:00.000Z",
    }));
  });
});
