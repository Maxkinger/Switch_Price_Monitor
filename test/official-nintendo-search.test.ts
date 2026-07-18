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

  it("parses Hong Kong official search RSC data into an eShop candidate", async () => {
    // 港区官网搜索结果将商品页写成 ec.nintendo.com 模板；适配器只能替换同一条官方数据中的 NSUID，不能接受页面中任意外链。
    // Cloudflare Worker 会被港区 Magento 商城搜索拒绝，因此名称搜索只能访问经生产验证可用的普通香港官网一次；关联商品须在后续详情解析中补齐。
    const fetchOfficialSearch = vi.fn<typeof fetch>().mockResolvedValue(new Response(hongKongSearchHtml()));
    const search = createOfficialNintendoSearch(fetchOfficialSearch);

    await expect(search.search("HK", "Overcooked 2", new AbortController().signal)).resolves.toMatchObject({
      status: "available",
      candidates: expect.arrayContaining([{
        regionCode: "HK",
        productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000106253",
        canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition",
        publisher: "Team17",
        productType: "game",
        currency: "HKD",
        coverUrl: "https://images.ctfassets.net/example/overcooked-hk.jpg?w=320&fm=webp",
        currentPriceMinor: null,
        regularPriceMinor: null,
      }]),
    });
    expect(fetchOfficialSearch).toHaveBeenCalledTimes(1);
    expect(String(fetchOfficialSearch.mock.calls[0]?.[0])).toBe("https://www.nintendo.com/hk/search?k=Overcooked+2");
  });

  it("falls back safely when the single Hong Kong official search endpoint rejects the Worker", async () => {
    // HTTP 拒绝只能说明本次普通香港官网搜索不可用；响应不能附带临时网络诊断，也不能再次访问已知会拒绝 Worker 的 Magento 入口。
    const fetchOfficialSearch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const search = createOfficialNintendoSearch(fetchOfficialSearch);

    await expect(search.search("HK", "Overcooked! 2 - Gourmet Edition", new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。",
    });
    expect(fetchOfficialSearch).toHaveBeenCalledTimes(1);
  });

  it("uses the Japanese Nintendo public software API and constructs only a numeric Store product URL", async () => {
    // 日区 API 的数字 nsuid 与 My Nintendo Store 的 D 前缀 URL 一一对应；带 -2 的实体版搜索 ID 不可推导为下载商品，必须丢弃。
    const search = createOfficialNintendoSearch(async (request) => {
      const url = new URL(String(request));
      expect(url.origin).toBe("https://search.nintendo.jp");
      expect(url.pathname).toBe("/nintendo_soft/search.json");
      expect(Object.fromEntries(url.searchParams)).toEqual({ q: "Overcooked 2", limit: "20", page: "1", opt_search: "1" });
      return Response.json({
        result: {
          items: [
            {
              id: "70010000106252",
              nsuid: "70010000106252",
              title: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
              maker: "Team17",
              sform: "BEE_DL",
              current_price: 3740,
              price: 3740,
              upgrade: 1,
            },
            {
              id: "70010000038868-2",
              nsuid: "70010000038868",
              title: "实体版不能推导为商店 URL",
              maker: "Team17",
              sform: "HAC_CARD",
              current_price: 5280,
              price: 5280,
            },
            {
              // 日区官方 API 把美食家版公开为 `DL_DLC`；它是独立购买的组合商品而非普通 DLC，
              // 必须映射为 bundle，才能与美区的官方 Gourmet Edition 保持同一订阅类型。
              id: "70070000010202",
              nsuid: "70070000010202",
              title: "Overcooked® 2 - オーバークック２：真の食通エディション",
              maker: "Team17",
              sform: "DL_DLC",
              current_price: 1225,
              price: 4900,
            },
          ],
        },
      });
    });

    await expect(search.search("JP", "Overcooked 2", new AbortController().signal)).resolves.toEqual({
      status: "available",
      candidates: [{
        regionCode: "JP",
        productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
        canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
        publisher: "Team17",
        productType: "game",
        currency: "JPY",
        coverUrl: null,
        currentPriceMinor: 3740,
        regularPriceMinor: 3740,
      }, {
        regionCode: "JP",
        productUrl: "https://store-jp.nintendo.com/item/software/D70070000010202/",
        canonicalTitle: "Overcooked® 2 - オーバークック２：真の食通エディション",
        publisher: "Team17",
        productType: "bundle",
        currency: "JPY",
        // 促销价和常规价分别来自日区同一条官方搜索记录；日元没有小数位，因此不得再乘以 100。
        coverUrl: null,
        currentPriceMinor: 1225,
        regularPriceMinor: 4900,
      }],
    });
  });

  it("provides the official-link fallback when the Hong Kong RSC contract is unavailable", async () => {
    // 普通港区官网可达但 RSC 契约缺失时必须回退到人工官方链接；HTTP 200 不能被误报成“确实没有商品”。
    const fetchOfficialSearch = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>incomplete official page</html>"));
    const search = createOfficialNintendoSearch(fetchOfficialSearch);

    await expect(search.search("HK", "Overcooked", new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。",
    });
    expect(fetchOfficialSearch).toHaveBeenCalledTimes(1);
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

/** 构造官网 Next/RSC 搜索片段；夹具保留 `software.items` 的官方链接模板和地区字段，避免测试依赖真实网页或登录状态。 */
function hongKongSearchHtml(): string {
  const rscPayload = JSON.stringify({
    software: {
      items: [
        {
          region: "hongkong",
          title: "Overcooked! 2 – Nintendo Switch 2 Edition",
          nsuid: "70010000106253",
          pageLink: "https://ec.nintendo.com/HK/zh/titles/{NSUID}",
          publisher: "Team17",
          hardwareCategory: "Nintendo Switch 2 Edition",
          imageHero: { url: "https://images.ctfassets.net/example/overcooked-hk.jpg?w=320&fm=webp" },
        },
        {
          // 非香港记录及非官方模板即使同处 RSC 数据，也不能越过地区和 URL 白名单。
          region: "japan",
          title: "必须忽略的错误地区商品",
          nsuid: "70010000106252",
          pageLink: "https://example.test/titles/{NSUID}",
          publisher: "Team17",
        },
      ],
    },
  });
  return `<script>self.__next_f.push([1,${JSON.stringify(rscPayload)}])</script>`;
}
