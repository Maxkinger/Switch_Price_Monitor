import { describe, expect, it, vi } from "vitest";

import { createOfficialNintendoSearch } from "../src/worker/providers/official-nintendo-search";

/**
 * 官方商品搜索适配器必须把任天堂官网公开搜索结果收窄为可确认候选，测试始终注入本地响应，
 * 从而证明解析规则不依赖管理员账号、Cookie 或真实网络，也不会把网页结构变化变成不稳定的联网测试。
 */
describe("official Nintendo product search", () => {
  it("normalizes a verified US Nintendo result with sale price and regular price", async () => {
    // 价格均为最小货币单位，模拟官网搜索结果已经给出的促销价和原价；候选页据此才能正确显示划线原价与折扣。
    const search = createOfficialNintendoSearch(async (request) => {
      expect(String(request)).toContain("algolia.net");
      return Response.json({
        results: [{
          hits: [{
            productTitle: "Overcooked! 2",
            productLink: "/us/store/products/overcooked-2-switch/",
            publisher: "Team17",
            price: { salePrice: 999, regPrice: 2499, currency: "USD" },
            imageUrl: "https://assets.nintendo.com/overcooked.jpg",
            productType: "game",
          }],
        }],
      });
    });

    await expect(search.search("US", "Overcooked", new AbortController().signal)).resolves.toEqual({
      status: "available",
      candidates: [{
        regionCode: "US",
        productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/",
        canonicalTitle: "Overcooked! 2",
        publisher: "Team17",
        productType: "game",
        currency: "USD",
        coverUrl: "https://assets.nintendo.com/overcooked.jpg",
        currentPriceMinor: 999,
        regularPriceMinor: 2499,
      }],
    });
  });

  it("does not request a non-admitted regional search adapter and provides the official-link fallback", async () => {
    // 香港区尚无已验证的官方名称检索契约；调用方必须收到可操作的链接确认提示，而不是借用美区索引或混入第三方结果。
    const fetchOfficialSearch = vi.fn<typeof fetch>();
    const search = createOfficialNintendoSearch(fetchOfficialSearch);

    await expect(search.search("HK", "Overcooked", new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。",
    });
    expect(fetchOfficialSearch).not.toHaveBeenCalled();
  });

  it("drops malformed or non-Nintendo hits instead of exposing an unverified candidate", async () => {
    // 搜索响应属于外部公开输入：错误货币、非官方跳转地址和未知商品类型都不能进入订阅确认流程。
    const search = createOfficialNintendoSearch(async () => Response.json({
      results: [{
        hits: [
          { productTitle: "Bad currency", productLink: "/us/store/products/bad/", price: { salePrice: 999, currency: "JPY" }, productType: "game" },
          { productTitle: "External link", productLink: "https://example.test/item", price: { salePrice: 999, currency: "USD" }, productType: "game" },
          { productTitle: "Unknown type", productLink: "/us/store/products/unknown/", price: { salePrice: 999, currency: "USD" }, productType: "surprise" },
        ],
      }],
    }));

    await expect(search.search("US", "Overcooked", new AbortController().signal)).resolves.toEqual({ status: "available", candidates: [] });
  });
});
