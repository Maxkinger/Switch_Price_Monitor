import { describe, expect, it, vi } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import { GameNameService } from "../src/worker/services/game-name-service";

/** 游戏名称服务测试把网络与候选发现停在窄接口之外，专注证明来源优先级和无猜测回退。 */
describe("game name service", () => {
  it("uses a Tencent mainland title only when it has the same verified Hong Kong title ID", async () => {
    // 香港候选已经由发现服务证明身份；名称服务只能把 URL 中同一纯数字 ID 交给大陆提供方，不能提交标题搜索。
    const discovery = { resolveUniqueHongKongCandidate: vi.fn().mockResolvedValue(hongKongCandidate()) };
    const mainland = { resolve: vi.fn().mockResolvedValue("星之卡比 探索发现") };
    const service = new GameNameService(discovery, mainland);

    await expect(service.resolveOfficialName(anchor(), "https://ec.nintendo.com/HK/zh/titles/70010000000001")).resolves.toEqual({
      kind: "mainland_official",
      nameZh: "星之卡比 探索发现",
    });
    expect(mainland.resolve).toHaveBeenCalledExactlyOnceWith("70010000000001");
  });

  it("returns unavailable when Hong Kong candidates are ambiguous", async () => {
    // 歧义由发现层以 null 表达；名称层必须停止，不能用锚点、搜索顺序或同名文本挑选其中一项。
    const mainland = { resolve: vi.fn().mockResolvedValue(null) };
    const service = new GameNameService({ resolveUniqueHongKongCandidate: vi.fn().mockResolvedValue(null) }, mainland);

    await expect(service.resolveOfficialName(anchor())).resolves.toEqual({ kind: "unavailable" });
    expect(mainland.resolve).not.toHaveBeenCalled();
  });

  it("falls back to converted Hong Kong title when the Tencent same-ID page is unavailable", async () => {
    // 大陆页面不存在只允许采用已核验香港候选的字面繁转简；不得调用翻译、用锚点英文或改变商品身份字段。
    const service = new GameNameService(
      { resolveUniqueHongKongCandidate: vi.fn().mockResolvedValue(hongKongCandidate({ canonicalTitle: "薩爾達傳說 王國之淚" })) },
      { resolve: vi.fn().mockResolvedValue(null) },
    );

    await expect(service.resolveOfficialName(anchor())).resolves.toEqual({
      kind: "hong_kong_official",
      nameZh: "萨尔达传说 王国之泪",
    });
  });

  it("does not request a mainland page for any non-exact Hong Kong titles URL and safely uses the verified display title", async () => {
    // bundles、aocs、查询参数或片段没有可证明的一对一大陆 ID；即使香港候选可显示，也不能扩大腾讯页面请求范围。
    const mainland = { resolve: vi.fn() };
    const nonExactUrls = [
      "https://ec.nintendo.com/HK/zh/aocs/70050000000001",
      "https://ec.nintendo.com/HK/zh/bundles/70070000000001",
      "https://ec.nintendo.com/HK/zh/titles/70010000000001?from=sync",
      "https://ec.nintendo.com/HK/zh/titles/70010000000001#details",
      "https://ec.nintendo.com:8443/HK/zh/titles/70010000000001",
      "https://reader@ec.nintendo.com/HK/zh/titles/70010000000001",
    ];

    for (const productUrl of nonExactUrls) {
      const service = new GameNameService(
        { resolveUniqueHongKongCandidate: vi.fn().mockResolvedValue(hongKongCandidate({
          productUrl,
          canonicalTitle: "額外內容",
          productType: "dlc",
        })) },
        mainland,
      );
      await expect(service.resolveOfficialName(anchor({ productType: "dlc" }))).resolves.toEqual({
        kind: "hong_kong_official",
        nameZh: "额外内容",
      });
    }
    expect(mainland.resolve).not.toHaveBeenCalled();
  });

  it("returns unavailable when the verified Hong Kong display title cannot produce a non-empty simplified name", async () => {
    // 转换异常必须降级而不是保存空字符串或回退猜测；这能阻止异常页面标题自动覆盖现有游戏名称。
    const service = new GameNameService(
      { resolveUniqueHongKongCandidate: vi.fn().mockResolvedValue(hongKongCandidate({ canonicalTitle: "   " })) },
      { resolve: vi.fn().mockResolvedValue(null) },
    );

    await expect(service.resolveOfficialName(anchor())).resolves.toEqual({ kind: "unavailable" });
  });
});

/** 默认区锚点只提供商品身份信号；其英文标题永远不能直接成为自动中文名称。 */
function anchor(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    regionCode: "US",
    productUrl: "https://www.nintendo.com/us/store/products/kirby-and-the-forgotten-land-switch/",
    canonicalTitle: "Kirby and the Forgotten Land",
    publisher: "Nintendo",
    productType: "game",
    currency: "USD",
    coverUrl: null,
    currentPriceMinor: 5999,
    regularPriceMinor: 5999,
    ...overrides,
  };
}

/** 港区候选夹具保留完整官方公开字段，使名称服务只能读取已核验 URL ID 与用于显示的 canonicalTitle。 */
function hongKongCandidate(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    ...anchor(),
    regionCode: "HK",
    productUrl: "https://ec.nintendo.com/HK/zh/titles/70010000000001",
    canonicalTitle: "星之卡比 探索發現",
    currency: "HKD",
    currentPriceMinor: null,
    regularPriceMinor: null,
    ...overrides,
  };
}
