import { describe, expect, it, vi } from "vitest";

import type { OfficialProductCandidate, OfficialProductSearch } from "../src/shared/domain";
import { OfficialProductDiscoveryService } from "../src/worker/services/official-product-discovery-service";

/**
 * 商品发现服务测试以可注入的设置、名称搜索和官方页面解析器替代 D1 与真实任天堂请求，
 * 证明默认区由服务端设置控制，且香港区可安全进入官方链接确认流程而不会借用美区候选。
 */
describe("official product discovery service", () => {
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

/** 返回一条完整美区候选，作为默认区搜索与跨区确认的稳定身份基线。 */
function usCandidate(): OfficialProductCandidate {
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
