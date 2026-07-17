import { describe, expect, it } from "vitest";

import { createNintendoPriceApiProvider } from "../src/worker/providers/official-nintendo-price-api";
import type { RegionalProduct } from "../src/worker/providers/types";

/**
 * 日区公开价格接口测试只使用内存响应，既验证请求中的地区与价格 ID 绑定，
 * 也避免测试或开发环境向任天堂发送真实请求、依赖排队页或暴露任何账户状态。
 */
describe("Nintendo Japanese official price API provider", () => {
  const product: RegionalProduct = {
    id: "jp-overcooked-upgrade",
    regionCode: "JP",
    currency: "JPY",
    // 该 ID 来自管理员已经确认的日区升级包链接；测试用固定公开样本，不包含用户购买或会话数据。
    officialPriceId: "70050000064985",
    productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
  };

  it("uses the confirmed Japanese price id and accepts only a matching JPY response", async () => {
    const provider = createNintendoPriceApiProvider(async (url) => {
      // URL 必须同时锁定地区、语言和本区价格 ID，避免同一标题在其他服的价格被误写入日区历史。
      expect(String(url)).toContain("country=JP");
      expect(String(url)).toContain("ids=70050000064985");
      expect(String(url)).toContain("lang=ja");
      return Response.json(japanesePriceResponse());
    });

    await expect(provider.fetch(product, new AbortController().signal)).resolves.toMatchObject({
      source: "official",
      amountMinor: 1000,
      currency: "JPY",
      officialPriceId: "70050000064985",
      title: product.canonicalTitle,
      publisher: product.publisher,
      productType: product.productType,
    });
  });

  it("rejects missing ids, another region, and API responses with mismatched identity or currency", async () => {
    const provider = createNintendoPriceApiProvider(async () => Response.json(japanesePriceResponse({ titleId: 70050000000000 })));
    const signal = new AbortController().signal;

    // 未确认官方 ID 或地区不属于日区时不应发出价格请求，后续来源链才能安全回退到第三方。
    await expect(provider.fetch({ ...product, officialPriceId: null }, signal)).resolves.toBeNull();
    await expect(provider.fetch({ ...product, regionCode: "US", currency: "USD" }, signal)).resolves.toBeNull();
    // 即便响应金额存在，只要返回的 title_id 与已确认映射不同，也绝不能接受为当前商品价格。
    await expect(provider.fetch(product, signal)).resolves.toBeNull();
  });
});

/** 构造任天堂价格接口的最小公开响应，调用方可仅替换会影响身份校验的字段。 */
function japanesePriceResponse(overrides: { titleId?: number; currency?: string } = {}) {
  return {
    country: "JP",
    prices: [{
      title_id: overrides.titleId ?? 70050000064985,
      sales_status: "onsale",
      regular_price: { amount: "1,000円", currency: overrides.currency ?? "JPY", raw_value: "1000" },
    }],
  };
}
