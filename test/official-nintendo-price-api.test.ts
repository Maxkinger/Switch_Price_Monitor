import { describe, expect, it } from "vitest";

import { createNintendoPriceApiProvider } from "../src/worker/providers/official-nintendo-price-api";
import type { RegionalProduct } from "../src/worker/providers/types";

/**
 * 任天堂公开价格接口测试只使用内存响应，既验证 JP/HK 请求中的地区与价格 ID 绑定，
 * 也避免测试或开发环境向任天堂发送真实请求、依赖排队页或暴露任何账户状态。
 */
describe("Nintendo official price API provider", () => {
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

  /**
   * 香港升级包使用 AOC 官方链接；该数字 ID 只在管理员已确认本区商品身份后使用，
   * 测试夹具固定为公开样本，确保不会把用户账户、购买记录或真实价格写入测试输出。
   */
  const hongKongProduct: RegionalProduct = {
    id: "hk-overcooked-upgrade",
    regionCode: "HK",
    currency: "HKD",
    officialPriceId: "70050000065163",
    productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163",
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

  it("uses Hong Kong parameters and prefers an official discounted HKD price", async () => {
    const provider = createNintendoPriceApiProvider(async (url) => {
      // 香港请求必须锁定国家、中文语言和本区 AOC ID，不能沿用日区参数或接受调用方拼接的任意地区。
      expect(String(url)).toContain("country=HK");
      expect(String(url)).toContain("ids=70050000065163");
      expect(String(url)).toContain("lang=zh");
      return Response.json(hongKongPriceResponse());
    });

    // 香港接口的 raw_value 是整港元；系统快照统一用最小货币单位，因此 HK$52 必须转换为 5,200 分后再写入历史。
    await expect(provider.fetch(hongKongProduct, new AbortController().signal)).resolves.toMatchObject({
      source: "official",
      amountMinor: 5200,
      currency: "HKD",
      officialPriceId: "70050000065163",
      title: hongKongProduct.canonicalTitle,
      publisher: hongKongProduct.publisher,
      productType: hongKongProduct.productType,
    });
  });

  it("rejects a Hong Kong response whose country, id, sale state, currency, or amount is invalid", async () => {
    const invalidResponses = [
      hongKongPriceResponse({ country: "JP" }),
      hongKongPriceResponse({ titleId: 70050000000000 }),
      hongKongPriceResponse({ salesStatus: "unavailable" }),
      hongKongPriceResponse({ currency: "JPY" }),
      hongKongPriceResponse({ rawValue: "52.00" }),
    ];

    for (const payload of invalidResponses) {
      const provider = createNintendoPriceApiProvider(async () => Response.json(payload));
      // 任一外部字段异常都必须停止当前官方来源，避免错误港币金额进入不可变快照或触发降价提醒。
      await expect(provider.fetch(hongKongProduct, new AbortController().signal)).resolves.toBeNull();
    }
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

/**
 * 构造香港公开 API 的最小促销响应；覆盖项只用于验证外部地区、ID、在售状态、币种与整数金额的拒绝边界，
 * 不访问真实香港商店，从而保持测试可重复且不会依赖任天堂页面的动态状态。
 */
function hongKongPriceResponse(overrides: {
  country?: string;
  titleId?: number;
  salesStatus?: string;
  currency?: string;
  rawValue?: string;
} = {}) {
  return {
    country: overrides.country ?? "HK",
    prices: [{
      title_id: overrides.titleId ?? 70050000065163,
      sales_status: overrides.salesStatus ?? "onsale",
      // 这是任天堂香港接口的真实数值口径：raw_value 是整港元，不是分；测试必须防止未来误把 52 写成 52 分。
      regular_price: { amount: "HKD 75", currency: overrides.currency ?? "HKD", raw_value: "75" },
      discount_price: { amount: "HKD 52", currency: overrides.currency ?? "HKD", raw_value: overrides.rawValue ?? "52" },
    }],
  };
}
