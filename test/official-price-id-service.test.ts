import { describe, expect, it } from "vitest";

import { OfficialPriceIdService } from "../src/worker/services/official-price-id-service";
import type { PriceProvider, ProviderResult } from "../src/worker/providers/types";

/**
 * 商品确认阶段只在内存中提取和验证价格 ID；测试通过固定官方结果覆盖 URL 边界，
 * 确保管理员取消预览时不会产生 D1 写入、真实网络请求或跨区 ID 复用。
 */
describe("OfficialPriceIdService", () => {
  const candidate = {
    regionCode: "JP" as const,
    currency: "JPY",
    productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack" as const,
  };

  it("extracts a Japanese price id from the confirmed URL and accepts it only after official verification", async () => {
    let receivedId: string | null = null;
    const service = new OfficialPriceIdService({
      source: "official",
      fetch: async (product) => {
        // 服务必须把 URL 中提取的无 D 前缀 ID 交给官方提供方二次验证，而不是仅相信链接文本。
        receivedId = product.officialPriceId;
        return verifiedResult(product.officialPriceId);
      },
    });

    await expect(service.resolve(candidate)).resolves.toEqual({ status: "official-available", officialPriceId: "70050000064985" });
    expect(receivedId).toBe("70050000064985");
  });

  it("keeps other regions and malformed Japanese URLs unavailable instead of guessing an official id", async () => {
    const service = new OfficialPriceIdService(verifiedProvider());

    // 日区 URL 规则未经验证前不能套用到美区，避免相同数字格式的链接被错误当作可用官方价格。
    await expect(service.resolve({ ...candidate, regionCode: "US", currency: "USD" })).resolves.toEqual({
      status: "official-id-unavailable", officialPriceId: null, reason: "unsupported-region",
    });
    await expect(service.resolve({ ...candidate, productUrl: "https://store-jp.nintendo.com/item/software/not-an-id" })).resolves.toEqual({
      status: "official-id-unavailable", officialPriceId: null, reason: "unrecognized-url",
    });
  });

  it("reports verification failure when the official provider cannot validate the extracted id", async () => {
    const service = new OfficialPriceIdService({ source: "official", fetch: async () => null });

    await expect(service.resolve(candidate)).resolves.toEqual({
      status: "official-id-unavailable", officialPriceId: null, reason: "official-verification-failed",
    });
  });
});

/** 构造只验证商品 ID 的离线官方来源桩件；真实网络与价格解析由日区 API 提供方的单独测试覆盖。 */
function verifiedProvider(): PriceProvider {
  return { source: "official", fetch: async (product) => verifiedResult(product.officialPriceId) };
}

/** 提供方只有在获得非空 ID 时才返回结果，模拟真实官方适配器拒绝未确认映射的行为。 */
function verifiedResult(officialPriceId: string | null): ProviderResult | null {
  if (officialPriceId === null) return null;
  return {
    source: "official",
    amountMinor: 1000,
    currency: "JPY",
    officialPriceId,
    title: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
    capturedAt: "2026-07-16T00:00:00.000Z",
  };
}
