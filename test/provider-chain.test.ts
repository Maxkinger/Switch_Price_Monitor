import { describe, expect, it } from "vitest";

import {
  ProviderChain,
  ProviderNetworkError,
  type PriceProvider,
  type ProviderResult,
  type RegionalProduct,
} from "../src/worker/providers/provider-chain";

/**
 * 提供方链测试仅使用内存桩件，不向任天堂或第三方网站发出请求。
 * 这样可以稳定验证官方优先、身份校验与重试规则，真实站点可行性则单独记录在 ADR 中。
 */
describe("ProviderChain", () => {
  const product: RegionalProduct = {
    id: "us-overcooked-upgrade",
    regionCode: "US",
    currency: "USD",
    // 此测试覆盖通用来源链而非日区价格接口，显式缺少价格 ID 可防止未来错误把任意官方结果当作地区 API 结果接受。
    officialPriceId: null,
    productUrl: "https://www.nintendo.com/us/store/products/example/",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
  };

  it("returns a marked fallback price when official collection fails", async () => {
    // 官方网络失败允许一次重试，仍失败后才按管理员设置的顺序尝试 eShop Prices；
    // 返回值保留第三方 source，后续规则层据此禁止触发即时官方降价提醒。
    const officialFails: PriceProvider = {
      source: "official",
      fetch: async () => {
        throw new ProviderNetworkError("official endpoint unavailable");
      },
    };
    const eshopPrices: PriceProvider = {
      source: "eshop-prices",
      fetch: async () => validResult({ source: "eshop-prices", amountMinor: 999 }),
    };

    const result = await new ProviderChain().fetch(product, [officialFails, eshopPrices]);

    expect(result).toMatchObject({ source: "eshop-prices", amountMinor: 999, currency: "USD" });
  });

  it("rejects a result whose title or product type differs from the confirmed product", async () => {
    // 同名本体、DLC 和升级包经常共存；即使来源给出价格，也必须拒绝商品类型不一致的候选，避免污染历史价格。
    const wrongProductType: PriceProvider = {
      source: "official",
      fetch: async () => validResult({ source: "official", productType: "game" }),
    };

    await expect(new ProviderChain().fetch(product, [wrongProductType])).resolves.toBeNull();
  });

  it("retries a transient network failure exactly once before accepting a valid official result", async () => {
    // 仅网络错误可重试一次：既能覆盖临时连接抖动，也不会对解析错误或身份不符商品反复请求第三方站点。
    let calls = 0;
    const flakyOfficial: PriceProvider = {
      source: "official",
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new ProviderNetworkError("temporary timeout");
        return validResult({ source: "official", amountMinor: 699 });
      },
    };

    await expect(new ProviderChain().fetch(product, [flakyOfficial])).resolves.toMatchObject({
      source: "official",
      amountMinor: 699,
    });
    expect(calls).toBe(2);
  });
});

/**
 * 构造与管理员已确认商品一致的可接受来源响应。测试只覆盖必要字段，
 * 调用方覆盖某字段即可精确描述想验证的来源、价格或身份不匹配条件。
 */
function validResult(overrides: Partial<ProviderResult>): ProviderResult {
  return {
    source: "official",
    amountMinor: 999,
    currency: "USD",
    title: "Overcooked 2 Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "TEAM17",
    productType: "upgrade-pack",
    capturedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}
