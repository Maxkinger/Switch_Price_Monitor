import { describe, expect, it, vi } from "vitest";

import type { OfficialProductCandidate, OfficialProductSearch } from "../src/shared/domain";
import type { OfficialPriceIdResolution } from "../src/worker/services/official-price-id-service";
import { JapaneseSubscriptionConfirmationService } from "../src/worker/services/japanese-subscription-confirmation-service";

/**
 * 日区最终确认测试只替换两个任天堂官方接口，不访问真实 My Nintendo Store 页面。
 * 这能证明动态或排队页面不可解析时，系统仍只接受搜索记录与价格 ID 两项官方证据的交集，
 * 而不会回退相信浏览器提交的标题、价格或发行商。
 */
describe("JapaneseSubscriptionConfirmationService", () => {
  it("rebuilds an automatic localized Japanese candidate only when official search and price APIs agree on one onsale JPY title ID", async () => {
    const anchor = usSwitch2EditionCandidate();
    const candidate = localizedJapaneseSwitch2EditionCandidate();
    const search = { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [candidate] }) };
    const prices = { resolve: vi.fn().mockResolvedValue(officialPriceId(candidate)) };
    const service = new JapaneseSubscriptionConfirmationService(search, prices);

    await expect(service.resolve(anchor, candidate, "automatic")).resolves.toEqual(candidate);
    // 最终复核以待保存的日区官方标题检索；美区英文标题未必能重新找到日区本地化商品，
    // 但结果仍必须包含同一精确官方 URL，不能只因标题相近就确认浏览器提交的候选。
    expect(search.search).toHaveBeenCalledWith("JP", candidate.canonicalTitle, expect.any(AbortSignal));
    expect(prices.resolve).toHaveBeenCalledWith(candidate);
  });

  it("rejects a search result with another official Japanese URL instead of returning browser supplied identity fields", async () => {
    const anchor = usSwitch2EditionCandidate();
    const candidate = localizedJapaneseSwitch2EditionCandidate();
    const anotherOfficialProduct = localizedJapaneseSwitch2EditionCandidate({ productUrl: "https://store-jp.nintendo.com/item/software/D70010000106253/" });
    const service = new JapaneseSubscriptionConfirmationService(
      { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [anotherOfficialProduct] }) },
      { resolve: vi.fn().mockResolvedValue(officialPriceId(anotherOfficialProduct)) },
    );

    await expect(service.resolve(anchor, candidate, "manual_selection")).resolves.toBeNull();
  });

  it("rejects unavailable Japanese search or price evidence", async () => {
    const anchor = usSwitch2EditionCandidate();
    const candidate = localizedJapaneseSwitch2EditionCandidate();
    const unavailableSearch = new JapaneseSubscriptionConfirmationService(
      { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" }) },
      { resolve: vi.fn() },
    );
    const unavailablePrice = new JapaneseSubscriptionConfirmationService(
      { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [candidate] }) },
      { resolve: vi.fn().mockResolvedValue({ status: "official-id-unavailable", officialPriceId: null, reason: "official-verification-failed" } satisfies OfficialPriceIdResolution) },
    );

    await expect(unavailableSearch.resolve(anchor, candidate, "manual_selection")).resolves.toBeNull();
    await expect(unavailablePrice.resolve(anchor, candidate, "manual_selection")).resolves.toBeNull();
  });

  it("rejects a price API result whose title ID differs from the exact Japanese Store URL", async () => {
    const anchor = usSwitch2EditionCandidate();
    const candidate = localizedJapaneseSwitch2EditionCandidate();
    const service = new JapaneseSubscriptionConfirmationService(
      { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [candidate] }) },
      // 即使下层意外把另一项官方价格标记为可用，确认服务也必须守住 URL 与价格 ID 的本区一一对应关系。
      { resolve: vi.fn().mockResolvedValue({ status: "official-available", officialPriceId: "70010000106253" } satisfies OfficialPriceIdResolution) },
    );

    await expect(service.resolve(anchor, candidate, "manual_selection")).resolves.toBeNull();
  });

  it("rejects an automatic localized candidate when the fresh official search has two equally high-confidence matches", async () => {
    const anchor = usSwitch2EditionCandidate();
    const candidate = localizedJapaneseSwitch2EditionCandidate();
    const duplicate = localizedJapaneseSwitch2EditionCandidate({ productUrl: "https://store-jp.nintendo.com/item/software/D70010000106253/" });
    const prices = { resolve: vi.fn().mockResolvedValue(officialPriceId(candidate)) };
    const service = new JapaneseSubscriptionConfirmationService(
      { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: [candidate, duplicate] }) },
      prices,
    );

    await expect(service.resolve(anchor, candidate, "automatic")).resolves.toBeNull();
    // 自动来源的唯一性不足时不应再调用价格 API，避免为不能确认的候选增加外部请求负载。
    expect(prices.resolve).not.toHaveBeenCalled();
  });

  it("keeps manual Japanese selection available after official double verification even when no automatic identity rule applies", async () => {
    const anchor = usSwitch2EditionCandidate();
    const candidate = localizedJapaneseSwitch2EditionCandidate({ publisher: "Team17 Japan" });
    const service = createService({ candidates: [candidate], price: officialPriceId(candidate) });

    await expect(service.resolve(anchor, candidate, "manual_selection")).resolves.toEqual(candidate);
  });
});

/** 创建可控的官方接口替身；默认与候选相同的价格 ID 证明服务不会从 URL 外的浏览器字段猜测 ID。 */
function createService(input: { candidates: OfficialProductCandidate[]; price: OfficialPriceIdResolution }): JapaneseSubscriptionConfirmationService {
  return new JapaneseSubscriptionConfirmationService(
    { search: vi.fn<OfficialProductSearch["search"]>().mockResolvedValue({ status: "available", candidates: input.candidates }) },
    { resolve: vi.fn().mockResolvedValue(input.price) },
  );
}

/** 自动身份复核的默认区锚点模拟美区官方搜索结果；它不能由调用方随意改变地区或币种。 */
function usSwitch2EditionCandidate(): OfficialProductCandidate {
  return {
    regionCode: "US",
    productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-switch-2/",
    canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition",
    publisher: "Team17",
    productType: "game",
    currency: "USD",
    coverUrl: null,
    currentPriceMinor: 999,
    regularPriceMinor: null,
  };
}

/** 日区候选使用实际 My Nintendo Store 下载版 URL 格式，并保留官方本地化标题以覆盖跨语言边界。 */
function localizedJapaneseSwitch2EditionCandidate(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    regionCode: "JP",
    productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
    canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
    publisher: "Team17",
    productType: "game",
    currency: "JPY",
    coverUrl: null,
    currentPriceMinor: 1000,
    regularPriceMinor: null,
    ...overrides,
  };
}

/** 价格 ID 必须由精确日区 URL 导出；测试显式构造它以锁定价格服务与官方搜索记录一致的业务条件。 */
function officialPriceId(candidate: OfficialProductCandidate): OfficialPriceIdResolution {
  const match = /\/D(\d+)\/?$/.exec(new URL(candidate.productUrl).pathname);
  return { status: "official-available", officialPriceId: match?.[1] ?? "" };
}
