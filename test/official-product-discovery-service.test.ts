import { describe, expect, it, vi } from "vitest";

import type { OfficialProductCandidate, OfficialProductSearch } from "../src/shared/domain";
import { officialCandidateKey, OfficialProductDiscoveryService } from "../src/worker/services/official-product-discovery-service";

/** 日区升级包人工核验只允许这一条完整、无参数的官方软件页；测试不能以模糊链接掩盖服务端关系证明的边界。 */
const upgradeUrl = "https://store-jp.nintendo.com/item/software/D70050000064985/";

/**
 * 商品发现服务测试以可注入的设置、名称搜索和官方页面解析器替代 D1 与真实任天堂请求，
 * 证明默认区由服务端设置控制，且香港区可安全进入官方链接确认流程而不会借用美区候选。
 */
describe("official product discovery service", () => {
  it("batches eligible Japanese upgrade fallbacks after ordinary regional search", async () => {
    // Browser Run 只能在普通官方搜索和受限本地化回退都没有同类型候选后调用；批量注入可防止每张卡各自启动浏览器会话。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack", productType: "upgrade-pack" });
    const jpUpgrade = japaneseCandidate({ canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス", productType: "upgrade-pack", productUrl: upgradeUrl });
    const japaneseUpgrades = {
      discover: vi.fn().mockResolvedValue(new Map([[officialCandidateKey(anchor), { status: "automatic", candidate: jpUpgrade }]])),
      resolveManual: vi.fn(),
    };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: vi.fn().mockResolvedValue({ status: "available", candidates: [] }) },
      { resolve: vi.fn() },
      { resolveRelated: vi.fn() },
      japaneseUpgrades,
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{ candidateKey: officialCandidateKey(anchor), regionCode: "JP", status: "automatic", candidate: jpUpgrade }]);
    expect(japaneseUpgrades.discover).toHaveBeenCalledExactlyOnceWith([anchor]);
  });

  it("preserves Japanese game link parsing while requiring an anchor for a parsed upgrade pack", async () => {
    // 日区普通游戏/DLC 没有升级关系时维持既有页面解析；页面若识别出升级包却没有锚点则拒绝返回，完整升级包锚点则必须直接走关系服务。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack", productType: "upgrade-pack" });
    const jpUpgrade = japaneseCandidate({ productType: "upgrade-pack", productUrl: upgradeUrl });
    const japaneseUpgrades = { discover: vi.fn(), resolveManual: vi.fn().mockResolvedValue(jpUpgrade) };
    const jpGame = japaneseCandidate({ productType: "game", productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/" });
    const pages = { resolve: vi.fn().mockResolvedValue(jpUpgrade).mockResolvedValueOnce(jpGame) };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: vi.fn() },
      pages,
      { resolveRelated: vi.fn() },
      japaneseUpgrades,
    );

    await expect(service.resolveOfficialLink("JP", upgradeUrl, anchor)).resolves.toEqual(jpUpgrade);
    expect(japaneseUpgrades.resolveManual).toHaveBeenCalledWith(anchor, upgradeUrl);
    expect(pages.resolve).not.toHaveBeenCalled();
    await expect(service.resolveOfficialLink("JP", jpGame.productUrl)).resolves.toEqual(jpGame);
    expect(pages.resolve).toHaveBeenCalledWith("JP", jpGame.productUrl, expect.any(AbortSignal));
    await expect(service.resolveOfficialLink("JP", upgradeUrl)).rejects.toThrow("日区升级包链接核验需要完整的默认区官方商品锚点。");
    await expect(service.resolveOfficialLink("JP", upgradeUrl, usCandidate({ productType: "game" }))).rejects.toThrow("日区升级包链接核验需要完整的默认区官方商品锚点。");
  });

  it("does not start Japanese upgrade discovery when ordinary official search is unavailable", async () => {
    // 官方搜索不可用时没有“普通回退为空”的可审计结论，Browser Run 不得作为替代搜索入口，必须直接保留人工官方链接路径。
    const anchor = usCandidate({ productType: "upgrade-pack" });
    const japaneseUpgrades = { discover: vi.fn(), resolveManual: vi.fn() };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: vi.fn().mockResolvedValue({ status: "unavailable", message: "日区官方搜索暂不可用。" }) },
      { resolve: vi.fn() },
      { resolveRelated: vi.fn() },
      japaneseUpgrades,
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{ candidateKey: officialCandidateKey(anchor), regionCode: "JP", status: "needs-manual-link" }]);
    expect(japaneseUpgrades.discover).not.toHaveBeenCalled();
  });

  it("does not start Japanese upgrade discovery when ordinary official search contains a same-type candidate", async () => {
    // 一条已验证的同类型官方候选已足以进入既有身份匹配流程；Browser Run 只能补足真正没有同类型结果的受限空白，而不能覆盖人工选择。
    const anchor = usCandidate({ productType: "upgrade-pack" });
    const ordinaryCandidate = japaneseCandidate({ productType: "upgrade-pack", canonicalTitle: "日区其他升级包" });
    const japaneseUpgrades = { discover: vi.fn(), resolveManual: vi.fn() };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: vi.fn().mockResolvedValue({ status: "available", candidates: [ordinaryCandidate] }) },
      { resolve: vi.fn() },
      { resolveRelated: vi.fn() },
      japaneseUpgrades,
    );

    await service.resolveRegions([anchor]);
    expect(japaneseUpgrades.discover).not.toHaveBeenCalled();
  });

  it("safely downgrades every eligible Japanese upgrade when batch discovery throws an ordinary error", async () => {
    // 未分类的 Browser、网络或价格异常不能泄漏给管理员，也不能中断其他普通地区结果；每个 eligible 锚点仅得到固定的人工链接说明。
    const anchor = usCandidate({ productType: "upgrade-pack" });
    const japaneseUpgrades = { discover: vi.fn().mockRejectedValue(new Error("external detail must stay private")), resolveManual: vi.fn() };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: vi.fn().mockResolvedValue({ status: "available", candidates: [] }) },
      { resolve: vi.fn() },
      { resolveRelated: vi.fn() },
      japaneseUpgrades,
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: officialCandidateKey(anchor),
      regionCode: "JP",
      status: "needs-manual-link",
      message: "日区自动核验暂不可用，请重新核验或粘贴官方链接。",
    }]);
  });

  it("uses the saved default search region instead of a browser-provided region", async () => {
    // 管理员可能在浏览器开发工具中伪造地区；服务必须始终读取持久化设置，防止不同区域商品被错误混合。
    const search = { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [usCandidate()] }) };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      search,
      { resolve: async () => null },
    );

    await expect(service.searchDefaultRegion("Overcooked")).resolves.toEqual({ status: "available", candidates: [usCandidate()] });
    expect(search.search).toHaveBeenCalledWith("US", "Overcooked", expect.any(AbortSignal));
  });

  it("accepts a verified Hong Kong Nintendo link and marks unavailable regional matching for manual confirmation", async () => {
    // 香港区没有已准入的名称搜索时，管理员仍必须能从本区官方链接得到候选，再由来源预览决定监控方式。
    const hk = { ...usCandidate(), regionCode: "HK" as const, currency: "HKD", productUrl: "https://www.nintendo.com/hk/soft/overcooked-2/" };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "HK"] }) },
      { search: async () => ({ status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" }) },
      { resolve: async () => hk },
    );

    await expect(service.resolveOfficialLink("HK", hk.productUrl)).resolves.toEqual(hk);
    await expect(service.resolveRegions([usCandidate()])).resolves.toEqual([
      { candidateKey: "US:https://www.nintendo.com/us/store/products/overcooked-2-switch/", regionCode: "HK", status: "needs-manual-link" },
    ]);
  });

  it("uses only saved enabled regions when resolving a selected default-region candidate", async () => {
    // 解析范围属于管理员设置而非浏览器表单；即使页面保留旧缓存或被篡改，也不得扩展到未启用地区请求任天堂。
    const search = { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" }) };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      search,
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([usCandidate()])).resolves.toEqual([
      { candidateKey: "US:https://www.nintendo.com/us/store/products/overcooked-2-switch/", regionCode: "JP", status: "needs-manual-link" },
    ]);
    expect(search.search).toHaveBeenCalledExactlyOnceWith("JP", usCandidate().canonicalTitle, expect.any(AbortSignal));
  });

  it("returns sorted same-type Japanese official candidates when the localized title cannot be auto-matched", async () => {
    // 日区标题可因本地化而无法与美区文字严格相等；这时系统不能猜测哪一项正确，
    // 但也不能丢弃已经由官方搜索验证的同类候选并要求管理员重新复制商品链接。
    const first = japaneseCandidate({ canonicalTitle: "A 料理ゲーム 2", productUrl: "https://store-jp.nintendo.com/item/software/D70010000000001/" });
    const second = japaneseCandidate({ canonicalTitle: "Z 料理ゲーム 2", productUrl: "https://store-jp.nintendo.com/item/software/D70010000000002/" });
    const wrongType = japaneseCandidate({ productType: "dlc", productUrl: "https://store-jp.nintendo.com/item/software/D70010000000003/" });
    const unverifiedUrl = japaneseCandidate({ canonicalTitle: "任意网页伪装的同类商品", productUrl: "https://example.test/jp/overcooked-2" });
    const search = {
      search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [second, wrongType, unverifiedUrl, first] }),
    };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      search,
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([usCandidate()])).resolves.toEqual([{
      candidateKey: "US:https://www.nintendo.com/us/store/products/overcooked-2-switch/",
      regionCode: "JP",
      status: "needs-manual-selection",
      candidates: [first, second],
      featuredCandidateCount: 2,
    }]);
  });

  it("keeps a unique strict regional match automatic", async () => {
    // 自动写入是更高信任级别：只有标题、类型及双方都有时的发行商都相同且唯一，
    // 才能免去管理员选择；后续放宽人工本地化候选时不得削弱这条边界。
    const strictMatch = japaneseCandidate({ canonicalTitle: "Overcooked! 2", publisher: "Team17" });
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: async () => ({ status: "available" as const, candidates: [strictMatch] }) },
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([usCandidate()])).resolves.toEqual([{
      candidateKey: "US:https://www.nintendo.com/us/store/products/overcooked-2-switch/",
      regionCode: "JP",
      status: "automatic",
      candidate: strictMatch,
    }]);
  });

  it("automatically matches one localized Japanese candidate when independent official identity signals agree", async () => {
    // 日文别名不应掩盖同一官方商品：拉丁主标题、Switch 2 Edition、发行商和受控类型全部一致且只有一项时，
    // 才能安全省去人工点击；本用例锁定该规则不会退化为仅比较完整英文标题。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition" });
    const localized = japaneseCandidate({ canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition" });
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: async () => ({ status: "available" as const, candidates: [localized] }) },
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "JP",
      status: "automatic",
      candidate: localized,
    }]);
  });

  it("keeps multiple localized matches manual and marks every high-confidence candidate as featured", async () => {
    // 即使两条日区商品都与锚点拥有足够身份信号，也不能按搜索顺序猜测；返回的推荐数量只指导前端展示，
    // 不会让浏览器自行确认或改变最终官方链接复验。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition" });
    const first = japaneseCandidate({ canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition", productUrl: "https://store-jp.nintendo.com/item/software/D70010000106251/" });
    const second = japaneseCandidate({ canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition", productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/" });
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: async () => ({ status: "available" as const, candidates: [second, first] }) },
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "JP",
      status: "needs-manual-selection",
      candidates: [first, second],
      featuredCandidateCount: 2,
    }]);
  });

  it("requires sorted manual selection when more than one strict official match exists", async () => {
    // 即使两项都满足自动身份规则，也不能任意挑选第一项；管理员必须看到完整官方候选。
    // 固定排序避免任天堂搜索响应的顺序波动导致页面选中状态错位或视觉闪烁。
    const first = japaneseCandidate({ canonicalTitle: "Overcooked! 2", productUrl: "https://store-jp.nintendo.com/item/software/D70010000000011/" });
    const second = japaneseCandidate({ canonicalTitle: "Overcooked! 2", productUrl: "https://store-jp.nintendo.com/item/software/D70010000000012/" });
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: async () => ({ status: "available" as const, candidates: [second, first] }) },
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([usCandidate()])).resolves.toEqual([{
      candidateKey: "US:https://www.nintendo.com/us/store/products/overcooked-2-switch/",
      regionCode: "JP",
      status: "needs-manual-selection",
      candidates: [first, second],
      featuredCandidateCount: 2,
    }]);
  });

  it("requires an official link only for unavailable or verified empty regional searches", async () => {
    // “搜索失败”与“官方确认没有候选”都会进入链接兜底，但两者都不能伪造候选卡；
    // 该用例同时锁定空集合边界，避免未来把非同类结果误当作可人工选择的商品。
    const createService = (result: Awaited<ReturnType<OfficialProductSearch["search"]>>) => new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      { search: async () => result },
      { resolve: async () => null },
    );
    const expected = [{
      candidateKey: "US:https://www.nintendo.com/us/store/products/overcooked-2-switch/",
      regionCode: "JP",
      status: "needs-manual-link",
    }];

    await expect(createService({ status: "available", candidates: [] }).resolveRegions([usCandidate()])).resolves.toEqual(expected);
    await expect(createService({ status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" }).resolveRegions([usCandidate()])).resolves.toEqual(expected);
    });
  });

  it("automatically matches a unique official Japanese Gourmet Edition bundle", async () => {
    // 美区英文搜索词在日区只会先返回同系列 Switch 2 本体；服务只能从这条官方结果中提取唯一日文别名再检索一次，
    // 之后仍须以 bundle、Team17、拉丁主标题与美食家版本标记四项证据自动确认，不能把本体直接替换成组合商品。
    const anchor = usCandidate({
      canonicalTitle: "Overcooked! 2 - Gourmet Edition",
      productType: "bundle",
    });
    const seriesAnchor = japaneseCandidate({
      canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
      productType: "game",
      productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
    });
    const localized = japaneseCandidate({
      canonicalTitle: "Overcooked® 2 - オーバークック２：真の食通エディション",
      productType: "bundle",
      productUrl: "https://store-jp.nintendo.com/item/software/D70070000010202/",
    });
    const search = {
      search: vi.fn<OfficialProductSearch["search"]>().mockImplementation(async (_regionCode, query) => {
        // 夹具按搜索词区分两次官方响应，证明二次检索的输入不能由浏览器伪造，而是必须是首条官方候选中的日文系列别名。
        if (query === anchor.canonicalTitle) return { status: "available" as const, candidates: [seriesAnchor] };
        return { status: "available" as const, candidates: [localized] };
      }),
    };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      search,
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "JP",
      status: "automatic",
      candidate: localized,
    }]);
    expect(search.search).toHaveBeenNthCalledWith(1, "JP", anchor.canonicalTitle, expect.any(AbortSignal));
    expect(search.search).toHaveBeenNthCalledWith(2, "JP", "オーバークック2", expect.any(AbortSignal));
  });

  it("does not guess a Japanese fallback query when the first official result has no unique same-series Japanese alias", async () => {
    // 二次检索最多一次且仅接受唯一、同发行商且含相同拉丁系列标记的日文别名；别名缺失或歧义必须停在手动链接路径，
    // 否则普通日文词可能扩大检索面，把同发行商的其他组合商品误加入订阅。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 - Gourmet Edition", productType: "bundle" });
    const unrelated = japaneseCandidate({ canonicalTitle: "Team17 Collection", productType: "game" });
    const search = {
      search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [unrelated] }),
    };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "JP"] }) },
      search,
      { resolve: async () => null },
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "JP",
      status: "needs-manual-link",
    }]);
    expect(search.search).toHaveBeenCalledExactlyOnceWith("JP", anchor.canonicalTitle, expect.any(AbortSignal));
  });

  it("discovers a unique Hong Kong Gourmet Edition through a verified base-title relation", async () => {
    // 港区普通搜索不直接返回 Gourmet 组合商品：服务只可剥离已知版本后缀再搜索一次本体，展开其一层官方关系并复核关联详情。
    const anchor = usCandidate({
      canonicalTitle: "Overcooked! 2 - Gourmet Edition",
      productType: "bundle",
    });
    const firstRoot = hongKongBaseCandidate();
    const secondRoot = hongKongBaseCandidate({ productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000106253", canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition" });
    const verified = hongKongCandidate({ publisher: "Team17", coverUrl: "https://img-eshop.cdn.nintendo.net/i/overcooked-gourmet-hk.jpg" });
    const search = {
      search: vi.fn<OfficialProductSearch["search"]>().mockImplementation(async (_regionCode, query) => ({
        status: "available" as const,
        candidates: query === anchor.canonicalTitle ? [] : [firstRoot, secondRoot],
      })),
    };
    const pageResolver = { resolve: vi.fn().mockResolvedValue(verified) };
    const relatedResolver = {
      resolveRelated: vi.fn().mockImplementation(async (_regionCode, productUrl) => productUrl === firstRoot.productUrl ? [{
        regionCode: "HK" as const,
        productUrl: verified.productUrl,
        canonicalTitle: verified.canonicalTitle,
        productType: "bundle" as const,
        coverUrl: verified.coverUrl,
      }] : []),
    };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "HK"] }) },
      search,
      pageResolver,
      relatedResolver,
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "HK",
      status: "automatic",
      candidate: verified,
    }]);
    expect(search.search).toHaveBeenNthCalledWith(1, "HK", anchor.canonicalTitle, expect.any(AbortSignal));
    expect(search.search).toHaveBeenNthCalledWith(2, "HK", "Overcooked! 2", expect.any(AbortSignal));
    expect(relatedResolver.resolveRelated).toHaveBeenCalledWith("HK", firstRoot.productUrl, expect.any(AbortSignal));
    expect(pageResolver.resolve).toHaveBeenCalledWith("HK", verified.productUrl, expect.any(AbortSignal));
  });

  it("rejects Hong Kong relation expansion when the controlled base search returns more than five roots", async () => {
    // 本体根超过固定上限时不能继续发起详情请求；这既限制 Worker 请求放大，也避免宽泛系列搜索产生不可靠的自动唯一性。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 - Gourmet Edition", productType: "bundle" });
    const roots = Array.from({ length: 6 }, (_unused, index) => hongKongBaseCandidate({
      productUrl: `https://ec.nintendo.com/HK/zh/titles/${70010000033098 + index}`,
    }));
    const search = { search: vi.fn<OfficialProductSearch["search"]>()
      .mockResolvedValueOnce({ status: "available", candidates: [] })
      .mockResolvedValueOnce({ status: "available", candidates: roots }) };
    const pages = { resolve: vi.fn().mockResolvedValue(null) };
    const related = { resolveRelated: vi.fn().mockResolvedValue([]) };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "HK"] }) },
      search,
      pages,
      related,
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "HK",
      status: "needs-manual-link",
    }]);
    expect(related.resolveRelated).not.toHaveBeenCalled();
    expect(pages.resolve).not.toHaveBeenCalled();
  });

  it("fails closed when any Hong Kong base root cannot prove its complete relation set", async () => {
    // 多个受控本体根中任一详情结构失效时，不能利用另一根的部分 Gourmet 关系自动确认，否则唯一性结论不完整。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 - Gourmet Edition", productType: "bundle" });
    const roots = [hongKongBaseCandidate(), hongKongBaseCandidate({ productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000106253" })];
    const verified = hongKongCandidate({ publisher: "Team17" });
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "HK"] }) },
      { search: vi.fn<OfficialProductSearch["search"]>()
        .mockResolvedValueOnce({ status: "available", candidates: [] })
        .mockResolvedValueOnce({ status: "available", candidates: roots }) },
      { resolve: vi.fn().mockResolvedValue(verified) },
      { resolveRelated: vi.fn().mockResolvedValueOnce([{ regionCode: "HK", productUrl: verified.productUrl, canonicalTitle: verified.canonicalTitle, productType: "bundle", coverUrl: null }]).mockResolvedValueOnce(null) },
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "HK",
      status: "needs-manual-link",
    }]);
  });

  it("does not invent a Hong Kong base query for an unrecognized bundle edition suffix", async () => {
    // 版本后缀白名单只包含已确认的 Gourmet Edition；未知组合名不能被宽泛截断后继续搜索，以免误配同系列其他合集。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2 - Anniversary Collection", productType: "bundle" });
    const search = { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [] }) };
    const related = { resolveRelated: vi.fn().mockResolvedValue([]) };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "HK"] }) },
      search,
      { resolve: async () => null },
      related,
    );

    await expect(service.resolveRegions([anchor])).resolves.toEqual([{
      candidateKey: `US:${anchor.productUrl}`,
      regionCode: "HK",
      status: "needs-manual-link",
    }]);
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(related.resolveRelated).not.toHaveBeenCalled();
  });

  it("accepts a confirmed full-width colon before the Hong Kong Gourmet Edition suffix", async () => {
    // 任天堂本地化标题可能用全角冒号分隔版本名；该符号已在设计白名单内，只能移除完整 Gourmet Edition 后缀并搜索一次基础标题。
    const anchor = usCandidate({ canonicalTitle: "Overcooked! 2：Gourmet Edition", productType: "bundle" });
    const search = { search: vi.fn<OfficialProductSearch["search"]>()
      .mockResolvedValueOnce({ status: "available", candidates: [] })
      .mockResolvedValueOnce({ status: "available", candidates: [hongKongBaseCandidate()] }) };
    const service = new OfficialProductDiscoveryService(
      { get: async () => ({ defaultSearchRegion: "US", enabledRegions: ["US", "HK"] }) },
      search,
      { resolve: async () => null },
      { resolveRelated: async () => [] },
    );

    await service.resolveRegions([anchor]);
    expect(search.search).toHaveBeenNthCalledWith(2, "HK", "Overcooked! 2", expect.any(AbortSignal));
  });

/** 返回一条完整美区候选，作为默认区搜索与跨区确认的稳定身份基线。 */
function usCandidate(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    regionCode: "US",
    productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/",
    canonicalTitle: "Overcooked! 2",
    publisher: "Team17",
    productType: "game",
    currency: "USD",
    coverUrl: null,
    currentPriceMinor: 999,
    regularPriceMinor: null,
    ...overrides,
  };
}

/**
 * 构造仅用于服务层分流的日区官方下载候选。调用方可覆盖标题、类型或 URL，
 * 以验证发现服务只允许同类型结果进入人工选择，而不会因测试夹具共享美区 URL 误掩盖跨区校验缺陷。
 */
function japaneseCandidate(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    ...usCandidate(),
    regionCode: "JP",
    productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
    canonicalTitle: "オーバークック2",
    publisher: "Team17",
    currency: "JPY",
    currentPriceMinor: 2500,
    ...overrides,
  };
}

/** 港区 eShop 搜索只承诺组合商品 URL 与标题；发行商必须通过后续同 URL 官方详情页读取，不能在搜索夹具中伪造。 */
function hongKongCandidate(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    ...usCandidate(),
    regionCode: "HK",
    productUrl: "https://ec.nintendo.com/HK/zh/bundles/70070000010913",
    canonicalTitle: "Overcooked! 2 - Gourmet Edition",
    publisher: null,
    productType: "bundle",
    currency: "HKD",
    currentPriceMinor: null,
    regularPriceMinor: null,
    ...overrides,
  };
}

/** 港区关系发现只接受普通 titles 本体作为根；该夹具刻意保持 game 类型和完整发行商，供数量与地区白名单测试复用。 */
function hongKongBaseCandidate(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    ...usCandidate(),
    regionCode: "HK",
    productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000033098",
    canonicalTitle: "Overcooked! 2",
    currency: "HKD",
    currentPriceMinor: null,
    regularPriceMinor: null,
    ...overrides,
  };
}
