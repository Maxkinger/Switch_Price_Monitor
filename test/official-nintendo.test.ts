import { describe, expect, it } from "vitest";

import { createOfficialNintendoProvider } from "../src/worker/providers/official-nintendo";
import type { RegionalProduct } from "../src/worker/providers/types";

/**
 * 官方页解析测试使用最小化 JSON-LD 样本，不调用真实任天堂站点。
 * 这样可在页面结构更新时精确指出是价格字段、身份字段还是商品类型识别失效。
 */
describe("official Nintendo provider", () => {
  const product: RegionalProduct = {
    id: "us-overcooked-upgrade",
    regionCode: "US",
    currency: "USD",
    productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-upgrade-pack-switch-2/",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
  };

  it("parses the public JSON-LD offer without a Nintendo account or browser session", async () => {
    // 美国官方页在服务端 HTML 中嵌入 Product/Offer JSON-LD；解析这个公开结构可避免依赖用户 Cookie 或前端渲染。
    const provider = createOfficialNintendoProvider(async () => new Response(nintendoProductHtml({ price: "9.99" })));

    await expect(provider.fetch(product, new AbortController().signal)).resolves.toMatchObject({
      source: "official",
      amountMinor: 999,
      currency: "USD",
      title: product.canonicalTitle,
      publisher: "Team17",
      productType: "upgrade-pack",
    });
  });

  it("rejects an official page without a complete public offer instead of inventing a price", async () => {
    // 价格或币种缺失时返回 null，让来源链安全回退；绝不能把页面中无关的推荐商品价格当作目标商品价格。
    const provider = createOfficialNintendoProvider(async () => new Response(nintendoProductHtml({ price: null })));

    await expect(provider.fetch(product, new AbortController().signal)).resolves.toBeNull();
  });
});

/** 构造与公开 Product JSON-LD 等价的精简 HTML，便于只测试目标字段而不固化任天堂整页内容。 */
function nintendoProductHtml(input: { price: string | null }): string {
  const product = {
    "@context": "https://schema.org/",
    "@graph": [{
      "@type": ["VideoGame", "Product"],
      name: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
      publisher: { "@type": "Organization", name: "Team17" },
      offers: input.price === null ? {} : { "@type": "Offer", priceCurrency: "USD", price: input.price },
    }],
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(product)}</script></head><body></body></html>`;
}
