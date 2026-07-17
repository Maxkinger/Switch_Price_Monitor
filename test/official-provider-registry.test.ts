import { describe, expect, it } from "vitest";

import { createOfficialProviderRegistry } from "../src/worker/providers/official-provider-registry";
import type { RegionalProduct } from "../src/worker/providers/types";

/** 已确认的地区商品夹具只含公开身份字段，用来证明注册表不会把日区专用 API 错配给其他地区。 */
const jpProduct: RegionalProduct = {
  id: "product-jp",
  regionCode: "JP",
  currency: "JPY",
  officialPriceId: "70050000064985",
  productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
  canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
  publisher: "Team17",
  productType: "upgrade-pack",
};

/** 美区商品用相同的确认身份模拟跨区采集起点；币种不同是注册表必须严格检查的地区边界。 */
const usProduct: RegionalProduct = {
  ...jpProduct,
  id: "product-us",
  regionCode: "US",
  currency: "USD",
  officialPriceId: null,
  productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/",
};

describe("official provider registry", () => {
  it("places the Japanese price API before the official product page only for JP", () => {
    // 日区有已确认的地区专属价格 API，因此可先用 API，再在 API 不可用时尝试本区官方页面；顺序直接影响回退的可信边界。
    const registry = createOfficialProviderRegistry();

    expect(registry.providersFor(jpProduct).map((provider) => provider.source)).toEqual(["official", "official"]);
    // 其他地区不允许复用日区 API 规则，只能获得本区官方页面适配器。
    expect(registry.providersFor(usProduct)).toHaveLength(1);
  });

  it("returns no provider when a supported region carries the wrong regional currency", () => {
    // 错误币种意味着地区商品映射已经损坏；在网络请求前拒绝可防止把错误价格写入不可变历史。
    expect(createOfficialProviderRegistry().providersFor({ ...usProduct, currency: "JPY" })).toEqual([]);
  });
});
