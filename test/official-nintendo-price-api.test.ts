import { describe, expect, it } from "vitest";

import { createNintendoOfficialPriceQuoteResolver, createNintendoPriceApiProvider } from "../src/worker/providers/official-nintendo-price-api";
import { ProviderNetworkError, type RegionalProduct } from "../src/worker/providers/types";

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

/**
 * 报价解析器直接服务于日区升级包关系复核，因此只接受注入的内存 fetch，既证明当前价与常规价的业务边界，
 * 也确保测试不会访问任天堂网络、泄漏管理员会话或因商店实时促销变化而失去确定性。
 */
describe("Nintendo official price quote resolver", () => {
  const validInput = { titleId: 70050000064985, regularRawValue: "1000", discountRawValue: "700" };

  it("returns the current and regular JPY quote for an onsale matching title id", async () => {
    const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json(pricePayload(validInput)));

    // 日元 raw_value 已是最小可比较单位；有效促销必须同时保留常规价，供后续关系校验拒绝“免费”或串区候选。
    await expect(quotes.resolve("JP", "JPY", "70050000064985", new AbortController().signal)).resolves.toEqual({
      officialPriceId: "70050000064985",
      currency: "JPY",
      currentPriceMinor: 700,
      regularPriceMinor: 1000,
    });
  });

  it.each([
    ["country", { ...pricePayload(validInput), country: "US" }],
    ["title id", pricePayload({ ...validInput, titleId: 70050000064986 })],
    ["non-primitive title id", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], title_id: ["70050000064985"] }] }],
    ["sales status", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], sales_status: "notonsale" }] }],
    ["currency", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], discount_price: { currency: "USD", raw_value: "700" } }] }],
    ["non-integer", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], discount_price: { currency: "JPY", raw_value: "7.00" } }] }],
    ["discount above regular", pricePayload({ titleId: 70050000064985, regularRawValue: "700", discountRawValue: "1000" })],
  ])("rejects invalid %s evidence", async (_name, payload) => {
    const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json(payload));

    // 外部地区、ID、在售状态、货币或金额证据任一不完整即失败闭合，不能把异常促销伪造成零价或常规价。
    await expect(quotes.resolve("JP", "JPY", "70050000064985", new AbortController().signal)).resolves.toBeNull();
  });

  it("normalizes an undiscounted HKD regular price to minor units without inventing a regular quote", async () => {
    const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json({
      country: "HK",
      prices: [{ title_id: 70050000065163, sales_status: "onsale", regular_price: { currency: "HKD", raw_value: "75" } }],
    }));

    // 港元 raw_value 是整港元，快照比较必须换算为分；没有折扣证据时只返回当前可购价，不能虚构“原价”展示。
    await expect(quotes.resolve("HK", "HKD", "70050000065163", new AbortController().signal)).resolves.toEqual({
      officialPriceId: "70050000065163",
      currency: "HKD",
      currentPriceMinor: 7500,
      regularPriceMinor: null,
    });
  });

  it.each([
    ["missing", { country: "JP", prices: [{ title_id: validInput.titleId, sales_status: "onsale", discount_price: { currency: "JPY", raw_value: validInput.discountRawValue } }] }],
    ["malformed", { country: "JP", prices: [{ ...pricePayload(validInput).prices[0], regular_price: { currency: "JPY", raw_value: "10.00" } }] }],
  ])("rejects %s regular-price evidence even with a valid discount", async (_name, payload) => {
    const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json(payload));

    // 常规价是判定折扣是否真实的锚点；缺失或小数格式异常时，即使折扣字段可解析也不能把它写成安全报价。
    await expect(quotes.resolve("JP", "JPY", "70050000064985", new AbortController().signal)).resolves.toBeNull();
  });

  it("rejects a discount equal to the regular price", async () => {
    const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json(pricePayload({
      titleId: validInput.titleId,
      regularRawValue: "700",
      discountRawValue: "700",
    })));

    // 同价不是促销，返回 null 可阻止后续升级包关系校验把格式存在但无折扣的证据误当作有效报价。
    await expect(quotes.resolve("JP", "JPY", "70050000064985", new AbortController().signal)).resolves.toBeNull();
  });

  it("wraps fetch rejection as ProviderNetworkError for provider-chain retry", async () => {
    const quotes = createNintendoOfficialPriceQuoteResolver(async () => {
      throw new Error("temporary Nintendo transport failure");
    });

    // 注入 fetch 的拒绝会被规范化为可重试错误；测试不读取或断言任何远端响应正文，避免将外部内容带入错误边界。
    await expect(quotes.resolve("JP", "JPY", "70050000064985", new AbortController().signal)).rejects.toBeInstanceOf(ProviderNetworkError);
  });

  it("rejects HKD multiplication overflow instead of producing an unsafe price", async () => {
    const quotes = createNintendoOfficialPriceQuoteResolver(async () => Response.json({
      country: "HK",
      prices: [{ title_id: 70050000065163, sales_status: "onsale", regular_price: { currency: "HKD", raw_value: String(Number.MAX_SAFE_INTEGER) } }],
    }));

    // 港元换算乘以 100 后若越过安全整数范围，必须拒绝该外部金额，不能因精度截断产生错误快照或提醒。
    await expect(quotes.resolve("HK", "HKD", "70050000065163", new AbortController().signal)).resolves.toBeNull();
  });
});

/**
 * 构造报价解析器的最小日区促销响应。夹具刻意只含公开价格字段，验证解析器不会依赖标题或用户购买数据；
 * `raw_value` 以字符串表达，覆盖任天堂 API 的整数金额约束而不向测试引入真实网络价格。
 */
function pricePayload(input: { titleId: number; regularRawValue: string; discountRawValue: string }): { country: string; prices: Array<Record<string, unknown>> } {
  return {
    country: "JP",
    prices: [{
      title_id: input.titleId,
      sales_status: "onsale",
      regular_price: { currency: "JPY", raw_value: input.regularRawValue },
      discount_price: { currency: "JPY", raw_value: input.discountRawValue },
    }],
  };
}

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
