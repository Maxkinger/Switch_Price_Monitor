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

  it("resolves an official Hong Kong eShop page from its public search metadata", async () => {
    // 港区官网搜索结果链接到 ec.nintendo.com；该域名仍属任天堂，但它提供元数据而非既有 JSON-LD，因此缺少价格时必须保留 null 而非伪造金额。
    const resolver = createOfficialNintendoProductPageResolver(async () => new Response(hongKongEshopHtml()));

    await expect(resolver.resolve("HK", "https://ec.nintendo.com/HK/zh/titles/70010000106253", new AbortController().signal)).resolves.toEqual({
      regionCode: "HK",
      productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000106253",
      canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition",
      publisher: "Team17",
      productType: "game",
      currency: "HKD",
      coverUrl: "https://img-eshop.cdn.nintendo.net/i/overcooked-hk.jpg",
      currentPriceMinor: null,
      regularPriceMinor: null,
    });
  });

  it("resolves an official Hong Kong eShop bundle page from its public BundleItem data", async () => {
    // 真实 bundles 页面不提供 search.* 元标签；组合商品身份位于 Next RSC 的 BundleItem 片段中。
    // 解析器须把该片段的 nsUid 与 URL 数字 ID 绑定，避免同页推荐商品的标题或发行商污染当前商品。
    const resolver = createOfficialNintendoProductPageResolver(async () => new Response(hongKongEshopBundleHtml()));

    await expect(resolver.resolve("HK", "https://ec.nintendo.com/HK/zh/bundles/70070000010913", new AbortController().signal)).resolves.toEqual({
      regionCode: "HK",
      productUrl: "https://ec.nintendo.com/HK/zh/bundles/70070000010913",
      canonicalTitle: "Overcooked! 2 - Gourmet Edition",
      publisher: "Team17",
      productType: "bundle",
      currency: "HKD",
      coverUrl: "https://img-eshop.cdn.nintendo.net/i/overcooked-gourmet-hk.jpg",
      currentPriceMinor: null,
      regularPriceMinor: null,
    });
  });

  it("rejects a Hong Kong BundleItem whose official identifier does not equal the requested bundle URL", async () => {
    // RSC 同页可能含多个商品片段；只要 nsUid 不匹配请求 URL，就不能把另一条合法商品的公开字段借给当前候选。
    const resolver = createOfficialNintendoProductPageResolver(async () => new Response(hongKongEshopBundleHtml({ nsUid: "70070000010914" })));

    await expect(resolver.resolve("HK", "https://ec.nintendo.com/HK/zh/bundles/70070000010913", new AbortController().signal)).resolves.toBeNull();
  });

  it("extracts one-hop Hong Kong bundle, DLC and upgrade references with upgrade precedence", async () => {
    // 关系只能来自请求本体对应的 ApplicationItem；同一升级包同时出现在普通 DLC 和 upgradeInfo 时必须按 URL 去重，且保留更严格的升级包类型。
    const resolver = createOfficialNintendoProductPageResolver(async () => new Response(hongKongRelatedProductsHtml()));

    await expect(resolver.resolveRelated("HK", "https://ec.nintendo.com/HK/zh/titles/70010000033098", new AbortController().signal)).resolves.toEqual([
      {
        regionCode: "HK",
        productUrl: "https://ec.nintendo.com/HK/zh/bundles/70070000010913",
        canonicalTitle: "Overcooked! 2 - Gourmet Edition",
        productType: "bundle",
        coverUrl: "https://img-eshop.cdn.nintendo.net/i/gourmet.jpg",
      },
      {
        regionCode: "HK",
        productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000021623",
        canonicalTitle: "Overcooked! 2 - Carnival of Chaos",
        productType: "dlc",
        coverUrl: null,
      },
      {
        regionCode: "HK",
        productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163",
        canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition升級通行證",
        productType: "upgrade-pack",
        coverUrl: null,
      },
    ]);
  });

  it("does not expand second-hop Hong Kong relations", async () => {
    // 一层 bundle 自身即使携带看似合法的 DLC 数组也不得继续展开；否则一个本体详情可把抓取范围递归扩大到不可控数量。
    const resolver = createOfficialNintendoProductPageResolver(async () => new Response(hongKongRelatedProductsHtml({ includeNestedRelation: true })));
    const references = await resolver.resolveRelated("HK", "https://ec.nintendo.com/HK/zh/titles/70010000033098", new AbortController().signal);

    expect(references).not.toBeNull();
    expect(references).toHaveLength(3);
    expect(references).not.toContainEqual(expect.objectContaining({ productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000099999" }));
  });

  it("rejects unsafe Hong Kong relation roots, malformed identifiers and excessive fan-out", async () => {
    // 根身份不符、关系 ID 不能验证或唯一关系超过 50 条时都整批拒绝；不能跳过坏项后用不完整集合自动确认订阅。
    const mismatchedRoot = createOfficialNintendoProductPageResolver(async () => new Response(hongKongRelatedProductsHtml({ rootNsUid: "70010000033099" })));
    await expect(mismatchedRoot.resolveRelated("HK", "https://ec.nintendo.com/HK/zh/titles/70010000033098", new AbortController().signal)).resolves.toBeNull();

    const malformedRelation = createOfficialNintendoProductPageResolver(async () => new Response(hongKongRelatedProductsHtml({ malformedRelationId: true })));
    await expect(malformedRelation.resolveRelated("HK", "https://ec.nintendo.com/HK/zh/titles/70010000033098", new AbortController().signal)).resolves.toBeNull();

    const excessiveRelations = createOfficialNintendoProductPageResolver(async () => new Response(hongKongRelatedProductsHtml({ relationCount: 51 })));
    await expect(excessiveRelations.resolveRelated("HK", "https://ec.nintendo.com/HK/zh/titles/70010000033098", new AbortController().signal)).resolves.toBeNull();
  });

  it("does not read relations from Hong Kong bundle or add-on detail URLs", async () => {
    // 只有 titles 本体可作为关系根；bundles 与 aocs 再展开会形成第二跳，因此必须在发出网络请求前拒绝。
    let calls = 0;
    const resolver = createOfficialNintendoProductPageResolver(async () => {
      calls += 1;
      return new Response(hongKongRelatedProductsHtml());
    });

    await expect(resolver.resolveRelated("HK", "https://ec.nintendo.com/HK/zh/bundles/70070000010913", new AbortController().signal)).resolves.toBeNull();
    await expect(resolver.resolveRelated("HK", "https://ec.nintendo.com/HK/zh/aocs/70050000065163", new AbortController().signal)).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it("resolves a Hong Kong add-on detail only when its DlcItem identifier matches the aocs URL", async () => {
    // 关系引用仍只是线索；最终 aocs 候选必须重新读取自己的 DlcItem、发行商和 URL ID，不能继承本体或关系摘要中的身份。
    const resolver = createOfficialNintendoProductPageResolver(async () => new Response(hongKongAddOnHtml()));

    await expect(resolver.resolve("HK", "https://ec.nintendo.com/HK/zh/aocs/70050000065163", new AbortController().signal)).resolves.toEqual({
      regionCode: "HK",
      productUrl: "https://ec.nintendo.com/HK/zh/aocs/70050000065163",
      canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition升級通行證",
      publisher: "Team17",
      productType: "upgrade-pack",
      currency: "HKD",
      coverUrl: null,
      currentPriceMinor: null,
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

/** 构造港区 eShop 实际公开的搜索元标签最小夹具；它与 JSON-LD 页面分开验证，防止误把网页文字当作价格。 */
function hongKongEshopHtml(input: {
  title?: string;
  publisher?: string;
  coverUrl?: string;
} = {}): string {
  return [
    `<meta name="search.name" content="${input.title ?? "Overcooked! 2 – Nintendo Switch 2 Edition"}">`,
    `<meta name="search.publisher" content="${input.publisher ?? "Team17"}">`,
    `<meta name="search.thumbnail" content="${input.coverUrl ?? "https://img-eshop.cdn.nintendo.net/i/overcooked-hk.jpg"}">`,
  ].join("");
}

/** 构造与港区组合页相同的 RSC 字符串承载方式，确保 bundles 不会意外依赖普通商品才有的 search.* 元标签。 */
function hongKongEshopBundleHtml(input: { nsUid?: string } = {}): string {
  const fragment = {
    __typename: "BundleItem",
    nsUid: input.nsUid ?? "70070000010913",
    formalName: "Overcooked! 2 - Gourmet Edition",
    publisher: { name: "Team17" },
    heroBannerUrl: "https://img-eshop.cdn.nintendo.net/i/overcooked-gourmet-hk.jpg",
  };
  // Next 会把 RSC 文本放入 JSON 字符串参数；这里保留这一层转义，避免测试只覆盖理想化的裸 JSON。
  return `<script>self.__next_f.push([1,${JSON.stringify(`0:{\"fragment\":${JSON.stringify(fragment)}}`)}])</script>`;
}

/**
 * 构造港区本体详情的一层关系数据。夹具可定向制造根 ID、关系 ID 和数量边界，确保解析器遇到不完整官方数据时整批回退，
 * 同时把嵌套在 bundle 内的第二层关系保留为诱饵，证明实现不会递归扫描任意命名对象。
 */
function hongKongRelatedProductsHtml(input: {
  rootNsUid?: string;
  includeNestedRelation?: boolean;
  malformedRelationId?: boolean;
  relationCount?: number;
} = {}): string {
  const bundle = {
    __typename: "BundleItem",
    nsUid: input.malformedRelationId ? "not-a-number" : "70070000010913",
    formalName: "Overcooked! 2 - Gourmet Edition",
    heroBannerUrl: "https://img-eshop.cdn.nintendo.net/i/gourmet.jpg",
    ...(input.includeNestedRelation ? {
      dlcItems: { items: [{ __typename: "DlcItem", nsUid: "70050000099999", formalName: "不应展开的第二层 DLC", heroBannerUrl: null }] },
    } : {}),
  };
  const generatedDlcItems = input.relationCount === undefined
    ? [
        { __typename: "DlcItem", nsUid: "70050000021623", formalName: "Overcooked! 2 - Carnival of Chaos", heroBannerUrl: null },
        { __typename: "DlcItem", nsUid: "70050000065163", formalName: "Overcooked! 2 – Nintendo Switch 2 Edition升級通行證", heroBannerUrl: null },
      ]
    : Array.from({ length: input.relationCount }, (_unused, index) => ({
        __typename: "DlcItem",
        nsUid: String(70050000100000 + index),
        formalName: `受控数量测试 DLC ${index + 1}`,
        heroBannerUrl: null,
      }));
  const fragment = {
    __typename: "ApplicationItem",
    nsUid: input.rootNsUid ?? "70010000033098",
    formalName: "Overcooked! 2",
    includedBundleItems: input.relationCount === undefined ? [bundle] : [],
    dlcItems: { items: generatedDlcItems },
    upgradeInfo: input.relationCount === undefined ? [{
      upgradeDlcItemNsUid: "70050000065163",
      upgradeDlcItem: {
        __typename: "DlcItem",
        nsUid: "70050000065163",
        formalName: "Overcooked! 2 – Nintendo Switch 2 Edition升級通行證",
        heroBannerUrl: null,
      },
    }] : [],
  };
  return `<script>self.__next_f.push([1,${JSON.stringify(`0:{\"fragment\":${JSON.stringify(fragment)}}`)}])</script>`;
}

/** 构造港区 aocs 详情的 DlcItem 片段；解析时必须用 URL ID 绑定该对象，并从对象自身读取发行商。 */
function hongKongAddOnHtml(): string {
  const fragment = {
    __typename: "DlcItem",
    nsUid: "70050000065163",
    formalName: "Overcooked! 2 – Nintendo Switch 2 Edition升級通行證",
    publisher: { name: "Team17" },
    heroBannerUrl: null,
  };
  return `<script>self.__next_f.push([1,${JSON.stringify(`0:{\"fragment\":${JSON.stringify(fragment)}}`)}])</script>`;
}
