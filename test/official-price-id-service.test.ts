import { describe, expect, it } from "vitest";

import { OfficialPriceIdService } from "../src/worker/services/official-price-id-service";
import type { PriceProvider, ProviderResult } from "../src/worker/providers/types";

/**
 * 商品确认阶段只在内存中提取和验证地区价格 ID；测试通过固定官方结果覆盖 URL 边界，
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

  /**
   * 香港区的完整游戏与追加内容使用同一官方 eShop 主机、不同的受控路径；二者都必须由服务端从精确 URL 提取本区 ID，
   * 不能让管理员填写或从标题猜测数字，以免将其他地区、其他商品的价格错误绑定到订阅。
   */
  const hongKongTitleCandidate = {
    regionCode: "HK" as const,
    currency: "HKD",
    productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000106253",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition",
    publisher: "Team17",
    productType: "game" as const,
  };
  const hongKongAocCandidate = {
    ...hongKongTitleCandidate,
    productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
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

  it("extracts Hong Kong title and AOC ids only from exact verified official eShop paths", async () => {
    const receivedIds: string[] = [];
    const service = new OfficialPriceIdService({
      source: "official",
      fetch: async (product) => {
        // 记录服务传给官方提供方的 ID，证明两类香港路径均不会保留 URL 文本、查询参数或跨区前缀。
        if (product.officialPriceId !== null) receivedIds.push(product.officialPriceId);
        return verifiedResult(product.officialPriceId, product.currency);
      },
    });

    await expect(service.resolve(hongKongTitleCandidate)).resolves.toEqual({
      status: "official-available", officialPriceId: "70010000106253",
    });
    await expect(service.resolve(hongKongAocCandidate)).resolves.toEqual({
      status: "official-available", officialPriceId: "70050000065163",
    });
    expect(receivedIds).toEqual(["70010000106253", "70050000065163"]);

    // 非香港语言、额外路径和非数字值即使包含看似正确的 ID，也不能成为官方价格映射。
    await expect(service.resolve({ ...hongKongAocCandidate, productUrl: "https://ec.nintendo.com/HK/en/aocs/70050000065163" })).resolves.toMatchObject({
      status: "official-id-unavailable", reason: "unrecognized-url",
    });
    await expect(service.resolve({ ...hongKongAocCandidate, productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163/extra" })).resolves.toMatchObject({
      status: "official-id-unavailable", reason: "unrecognized-url",
    });
    await expect(service.resolve({ ...hongKongAocCandidate, productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163?otherRegionId=1" })).resolves.toMatchObject({
      status: "official-id-unavailable", reason: "unrecognized-url",
    });
    await expect(service.resolve({ ...hongKongAocCandidate, productUrl: "https://ec.nintendo.com/HK/zh/aocs/not-a-number" })).resolves.toMatchObject({
      status: "official-id-unavailable", reason: "unrecognized-url",
    });
  });
});

/** 构造只验证商品 ID 的离线官方来源桩件；真实网络与价格解析由日区 API 提供方的单独测试覆盖。 */
function verifiedProvider(): PriceProvider {
  return { source: "official", fetch: async (product) => verifiedResult(product.officialPriceId) };
}

/** 提供方只有在获得非空 ID 时才返回结果，模拟真实官方适配器拒绝未确认映射的行为。 */
function verifiedResult(officialPriceId: string | null, currency = "JPY"): ProviderResult | null {
  if (officialPriceId === null) return null;
  return {
    source: "official",
    amountMinor: 1000,
    currency,
    officialPriceId,
    title: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
    capturedAt: "2026-07-16T00:00:00.000Z",
  };
}
