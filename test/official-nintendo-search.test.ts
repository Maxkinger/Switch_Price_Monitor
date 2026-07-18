import { describe, expect, it, vi } from "vitest";

import { createOfficialNintendoSearch } from "../src/worker/providers/official-nintendo-search";

/**
 * 官方商品搜索适配器必须把任天堂官网公开搜索结果收窄为可确认候选，测试始终注入本地响应，
 * 从而证明解析规则不依赖管理员账号、Cookie 或真实网络，也不会把网页结构变化变成不稳定的联网测试。
 */
describe("official Nintendo product search", () => {
  it("normalizes the current US Nintendo search schema with sale price and regular price", async () => {
    // 任天堂当前公开索引使用 title/url/eshopDetails，金额是美元主单位；适配器必须安全换算为分，才能保留候选页的划线原价与折扣。
    const search = createOfficialNintendoSearch(async (request) => {
      expect(String(request)).toContain("algolia.net");
      return Response.json({
        results: [{
          hits: [{
            title: "Overcooked! 2",
            url: "/us/store/products/overcooked-2-switch/",
            softwarePublisher: "Team17",
            productImageSquare: "https://assets.nintendo.com/overcooked.jpg",
            isUpgrade: false,
            eshopDetails: { productType: "TITLE", regularPrice: 24.99, discountPrice: 9.99, currency: "USD" },
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

  it("uses the dedicated Mexican official index and rejects a currency-mismatched hit", async () => {
    // 墨西哥区必须查询任天堂西语墨西哥索引，不能重用美区索引；货币与地区不一致的命中即使链接看似正确也不能成为跨区订阅候选。
    const search = createOfficialNintendoSearch(async (_request, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        requests: [{ indexName: "store_game_es_mx", query: "Overcooked", params: "hitsPerPage=20" }],
      });
      return Response.json({
        results: [{
          hits: [
            {
              title: "Overcooked! 2 - Gourmet Edition",
              url: "/es-mx/store/products/overcooked-2-gourmet-edition-switch/",
              softwarePublisher: "Team17",
              productImageSquare: "https://assets.nintendo.com/overcooked-mx.jpg",
              isUpgrade: false,
              eshopDetails: { productType: "TITLE", regularPrice: 499, discountPrice: 249.5, currency: "MXN" },
            },
            {
              title: "Currency mismatch",
              url: "/es-mx/store/products/not-mexican-switch/",
              softwarePublisher: "Team17",
              isUpgrade: false,
              eshopDetails: { productType: "TITLE", regularPrice: 99, discountPrice: null, currency: "USD" },
            },
          ],
        }],
      });
    });

    await expect(search.search("MX", "Overcooked", new AbortController().signal)).resolves.toEqual({
      status: "available",
      candidates: [{
        regionCode: "MX",
        productUrl: "https://www.nintendo.com/es-mx/store/products/overcooked-2-gourmet-edition-switch/",
        canonicalTitle: "Overcooked! 2 - Gourmet Edition",
        publisher: "Team17",
        productType: "game",
        currency: "MXN",
        coverUrl: "https://assets.nintendo.com/overcooked-mx.jpg",
        currentPriceMinor: 24950,
        regularPriceMinor: 49900,
      }],
    });
  });

  it("uses the dedicated Brazilian official index and rejects an out-of-region URL", async () => {
    // 巴西区的公开索引与墨西哥区不同；解析器还必须核验 URL 前缀，避免索引异常时把另一服或外站地址交给后续官方页面验证。
    const search = createOfficialNintendoSearch(async (_request, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        requests: [{ indexName: "store_game_pt_br", query: "Overcooked", params: "hitsPerPage=20" }],
      });
      return Response.json({
        results: [{
          hits: [
            {
              title: "Overcooked! 2 - Gourmet Edition",
              url: "/pt-br/store/products/overcooked-2-gourmet-edition-switch/",
              softwarePublisher: "Team17",
              productImageSquare: "https://assets.nintendo.com/overcooked-br.jpg",
              isUpgrade: false,
              eshopDetails: { productType: "TITLE", regularPrice: 124.9, discountPrice: null, currency: "BRL" },
            },
            {
              title: "Wrong regional URL",
              url: "/us/store/products/not-brazilian-switch/",
              softwarePublisher: "Team17",
              isUpgrade: false,
              eshopDetails: { productType: "TITLE", regularPrice: 124.9, discountPrice: null, currency: "BRL" },
            },
          ],
        }],
      });
    });

    await expect(search.search("BR", "Overcooked", new AbortController().signal)).resolves.toEqual({
      status: "available",
      candidates: [{
        regionCode: "BR",
        productUrl: "https://www.nintendo.com/pt-br/store/products/overcooked-2-gourmet-edition-switch/",
        canonicalTitle: "Overcooked! 2 - Gourmet Edition",
        publisher: "Team17",
        productType: "game",
        currency: "BRL",
        coverUrl: "https://assets.nintendo.com/overcooked-br.jpg",
        currentPriceMinor: 12490,
        regularPriceMinor: 12490,
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

  it("returns the official-link fallback when the public search request times out", async () => {
    // 搜索页不可无限等待外部公开索引；超时后返回人工官方链接入口，管理员仍可继续确认商品而不是误以为按钮失效。
    const search = createOfficialNintendoSearch((_request, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")), { once: true });
    }) as Promise<Response>, 1);

    await expect(search.search("US", "Overcooked", new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。",
    });
  });
});
