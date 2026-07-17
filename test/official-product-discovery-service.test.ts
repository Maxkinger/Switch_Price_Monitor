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
      { get: async () => ({ defaultSearchRegion: "US" }) },
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
      { get: async () => ({ defaultSearchRegion: "US" }) },
      { search: async () => ({ status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" }) },
      { resolve: async () => hk },
    );

    await expect(service.resolveOfficialLink("HK", hk.productUrl)).resolves.toEqual(hk);
    await expect(service.resolveRegions([usCandidate()], ["US", "HK"])).resolves.toEqual([
      { candidateKey: "US:https://www.nintendo.com/us/store/products/overcooked-2-switch/", regionCode: "HK", status: "needs-manual-link" },
    ]);
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
