import { describe, expect, it } from "vitest";

import { createOfficialNintendoProductPageResolver } from "../src/worker/providers/official-nintendo-product-page";

/**
 * 官方链接解析器只读取最小 JSON-LD 夹具，确保测试验证的是本系统对公开身份与价格字段的边界，
 * 不依赖任天堂实际页面、管理员 Cookie 或浏览器渲染，页面结构改变时也能得到稳定的失败信号。
 */
describe("official Nintendo product page resolver", () => {
  it("resolves a Hong Kong Nintendo product page into a public candidate", async () => {
    // 香港区不能借用美区名称索引；管理员粘贴本区官方链接后，解析器应保留 HKD、封面和可验证的公开报价。
    const resolver = createOfficialNintendoProductPageResolver(async () => new Response(productHtml({
      title: "Overcooked! 2",
      publisher: "Team17",
      currency: "HKD",
      price: "188.00",
      image: "https://assets.nintendo.com/hk-overcooked.jpg",
    })));

    await expect(resolver.resolve("HK", "https://www.nintendo.com/hk/soft/overcooked-2/", new AbortController().signal)).resolves.toEqual({
      regionCode: "HK",
      productUrl: "https://www.nintendo.com/hk/soft/overcooked-2/",
      canonicalTitle: "Overcooked! 2",
      publisher: "Team17",
      productType: "game",
      currency: "HKD",
      coverUrl: "https://assets.nintendo.com/hk-overcooked.jpg",
      currentPriceMinor: 18800,
      regularPriceMinor: null,
    });
  });

  it("rejects a URL outside the selected Nintendo region before requesting it", async () => {
    // 输入链接是浏览器不可信数据；将任意主机转发给解析器会构成 SSRF 风险，因此链接必须先以地区主机白名单拒绝。
    let calls = 0;
    const resolver = createOfficialNintendoProductPageResolver(async () => {
      calls += 1;
      return new Response(productHtml({ title: "Unexpected", publisher: "Team17", currency: "HKD", price: "188.00", image: null }));
    });

    await expect(resolver.resolve("HK", "https://example.test/hk/soft/overcooked-2/", new AbortController().signal)).resolves.toBeNull();
    expect(calls).toBe(0);
  });
});

/** 构造与公开 Product JSON-LD 等价的最小商品页，使解析测试只覆盖确认所需字段与货币精度。 */
function productHtml(input: { title: string; publisher: string; currency: string; price: string; image: string | null }): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org/",
    "@type": "Product",
    name: input.title,
    publisher: { "@type": "Organization", name: input.publisher },
    image: input.image,
    offers: { "@type": "Offer", priceCurrency: input.currency, price: input.price },
  })}</script>`;
}
