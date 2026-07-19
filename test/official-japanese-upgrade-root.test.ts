import { describe, expect, it } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import { createOfficialJapaneseUpgradeRootSearch } from "../src/worker/providers/official-japanese-upgrade-root";

/**
 * 日区升级根商品检索只信任注入的官方 API 响应，测试禁止访问真实网络。
 * 这既让外部搜索结构变化可重复验证，也确保升级包不会因数组顺序或浏览器会话而错误关联到另一款本体。
 */
describe("official Japanese upgrade root search", () => {
  it("returns the only official upgrade root with matching series and publisher", async () => {
    // 两条官方命中只有一条同时具备 upgrade:1、下载形态、Switch 2 Edition 与同发行商系列，不能按 API 顺序选择。
    const search = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload([
      japaneseItem({ id: "70010000106252", upgrade: 1 }),
      japaneseItem({ id: "70010000109999", title: "別のゲーム Nintendo Switch 2 Edition", maker: "Other", upgrade: 1 }),
    ])));

    await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toEqual({
      productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
      canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
      publisher: "Team17",
    });
  });

  it.each([0, 2])("fails closed when %i roots satisfy the complete identity", async (matchingCount) => {
    // 自动关联只能接受唯一完整身份；零条说明没有官方证据，两条说明无法安全判定，二者都不能按 API 顺序任选一条。
    const items = Array.from({ length: matchingCount }, (_, index) => japaneseItem({ id: String(70010000106252 + index), upgrade: 1 }));
    const search = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload(items)));

    await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toBeNull();
  });

  it.each([
    ["id/nsuid mismatch", japaneseItem({ nsuid: "70010000109999" })],
    ["unknown sform", japaneseItem({ sform: "CARD" })],
    ["missing upgrade flag", japaneseItem({ upgrade: 0 })],
    ["missing Switch 2 marker", japaneseItem({ title: "Overcooked® 2 - オーバークック２" })],
    ["publisher mismatch", japaneseItem({ maker: "Other" })],
  ])("rejects %s", async (_name, item) => {
    // 每一个根记录约束都独立阻断自动升级关系；任天堂外部数据即使只缺少一项也不能推导为可保存的本体链接。
    const search = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload([item])));

    await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toBeNull();
  });

  it("uses the fixed official Japanese endpoint and base-game query", async () => {
    // URL 与查询词都来自受控代码和升级包标题，调用者不能借此检索任意主机或保留升级包版本词而放宽结果集合。
    const search = createOfficialJapaneseUpgradeRootSearch(async (request, init) => {
      const url = new URL(String(request));
      expect(url.origin).toBe("https://search.nintendo.jp");
      expect(url.pathname).toBe("/nintendo_soft/search.json");
      expect(Object.fromEntries(url.searchParams)).toEqual({ q: "Overcooked! 2", limit: "20", page: "1", opt_search: "1" });
      expect(init?.headers).toEqual({ accept: "application/json" });
      return Response.json(japanesePayload([japaneseItem()]));
    });

    await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.not.toBeNull();
  });

  it("matches the first numbered Latin series segment before localized aliases and rejects a generic Switch marker", async () => {
    // `Overcooked! 2` 与日文别名前的 `Overcooked® 2` 必须归为同一系列；后续的 Nintendo Switch 2 Edition 只是版本词，
    // 不能被拼进系列标记，更不能让泛化的 `Switch 2` 在没有游戏名时独立证明升级关系。
    const matchingSearch = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload([japaneseItem()])));
    const genericSearch = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload([
      japaneseItem({ title: "Nintendo Switch 2 Edition" }),
    ])));

    await expect(matchingSearch.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.not.toBeNull();
    await expect(genericSearch.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toBeNull();
  });

  it.each([
    ["does not collapse Super Mario Bros. 2 to Mario Bros. 2", "Super Mario Bros. 2 – Nintendo Switch 2 Edition Upgrade Pack", "Mario Bros. 2 - マリオブラザーズ Nintendo Switch 2 Edition", false],
    ["does not collapse NBA 2K25 to NBA 2K26", "NBA 2K25 – Nintendo Switch 2 Edition Upgrade Pack", "NBA 2K26 - エヌビーエー２Ｋ２６ Nintendo Switch 2 Edition", false],
    ["matches the short numbered title F1 25", "F1 25 – Nintendo Switch 2 Edition Upgrade Pack", "F1 25 - エフワン２５ Nintendo Switch 2 Edition", true],
    ["rejects a generic Nintendo Switch marker", "Nintendo Switch 2 Edition Upgrade Pack", "Nintendo Switch 2 Edition", false],
  ])("%s", async (_name, anchorTitle, rootTitle, shouldMatch) => {
    // 系列边界必须在本地化文字前保留完整的前导拉丁/数字标题：不能只留下末尾 `bros2` 或 `nba2`，
    // 同时 F1 25 这类短标题仍须有资格匹配；只有游戏名与编号共同存在才能抵抗泛化硬件版本词误配。
    const search = createOfficialJapaneseUpgradeRootSearch(async () => Response.json(japanesePayload([
      japaneseItem({ title: rootTitle }),
    ])));
    const result = search.search(overcookedUpgradeUs({ canonicalTitle: anchorTitle }), new AbortController().signal);

    if (shouldMatch) await expect(result).resolves.toMatchObject({ canonicalTitle: rootTitle });
    else await expect(result).resolves.toBeNull();
  });

  it("fails closed for a non-OK or malformed official response", async () => {
    // HTTP 失败、无 items 路径和不能解码的 JSON 都表示本次无法证明根商品；不得把旧结果、异常正文或部分对象继续交给后续关系发现。
    const nonOkSearch = createOfficialJapaneseUpgradeRootSearch(async () => new Response(null, { status: 503 }));
    const malformedShapeSearch = createOfficialJapaneseUpgradeRootSearch(async () => Response.json({ result: { items: {} } }));
    const malformedJsonSearch = createOfficialJapaneseUpgradeRootSearch(async () => new Response("not-json", { headers: { "content-type": "application/json" } }));
    const signal = new AbortController().signal;

    await expect(nonOkSearch.search(overcookedUpgradeUs(), signal)).resolves.toBeNull();
    await expect(malformedShapeSearch.search(overcookedUpgradeUs(), signal)).resolves.toBeNull();
    await expect(malformedJsonSearch.search(overcookedUpgradeUs(), signal)).resolves.toBeNull();
  });

  it("fails closed when the injected official fetch rejects", async () => {
    // 网络层不携带可供用户查看的异常正文；公开端点不可达只意味着本轮没有可审计的根商品，必须返回 null 并交由人工路径处理。
    const search = createOfficialJapaneseUpgradeRootSearch(async () => Promise.reject(new Error("upstream detail must not leak")));

    await expect(search.search(overcookedUpgradeUs(), new AbortController().signal)).resolves.toBeNull();
  });

  it("does not request a root for an anchor without a verified upgrade identity", async () => {
    // 类型或发行商不足时不应发出外部请求：这条边界避免普通商品和匿名升级包扩大到不可审计的日区模糊匹配。
    let requestCount = 0;
    const search = createOfficialJapaneseUpgradeRootSearch(async () => {
      requestCount += 1;
      return Response.json(japanesePayload([japaneseItem()]));
    });

    await expect(search.search({ ...overcookedUpgradeUs(), productType: "game" }, new AbortController().signal)).resolves.toBeNull();
    await expect(search.search({ ...overcookedUpgradeUs(), publisher: null }, new AbortController().signal)).resolves.toBeNull();
    expect(requestCount).toBe(0);
  });
});

/**
 * 构造已验证的美区升级包锚点；根商品查找器必须要求该受控类型和非空发行商，
 * 不能从任意游戏标题猜测本体，以免把自动发现扩大为跨游戏的模糊搜索。
 */
function overcookedUpgradeUs(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    regionCode: "US",
    productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-upgrade-pack-switch-2/",
    canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
    currency: "USD",
    coverUrl: null,
    currentPriceMinor: 999,
    regularPriceMinor: null,
    ...overrides,
  };
}

/**
 * 生成官方日区搜索的最小项目；默认字段满足真实下载版根商品约束，覆盖项用于保持测试只改变本例身份信号。
 * ID 与 NSUID 默认相同，因为只有可安全映射为 My Nintendo Store 数字 URL 的记录才能成为候选。
 */
function japaneseItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = typeof overrides.id === "string" ? overrides.id : "70010000106252";
  return {
    id,
    nsuid: id,
    title: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
    maker: "Team17",
    sform: "BEE_DL",
    upgrade: 1,
    ...overrides,
  };
}

/**
 * 官方 API 的外层结构也属于不可信外部输入；将它集中构造使测试明确覆盖 parser 所依赖的唯一稳定路径。
 */
function japanesePayload(items: unknown[]): unknown {
  return { result: { items } };
}
