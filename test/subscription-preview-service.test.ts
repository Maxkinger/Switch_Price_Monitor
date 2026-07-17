import { describe, expect, it } from "vitest";

import { SubscriptionPreviewService } from "../src/worker/services/subscription-preview-service";
import type { OfficialPriceIdCandidate, OfficialPriceIdResolution } from "../src/worker/services/official-price-id-service";

/**
 * 预览服务测试仅注入地区 ID 解析结果，隔离“给管理员什么提示”的业务规则；
 * 它不请求任天堂、第三方站点或 D1，保证创建前比较候选的操作无外部副作用。
 */
describe("SubscriptionPreviewService", () => {
  const jpCandidate = candidate("JP", "JPY");
  const hkCandidate = candidate("HK", "HKD");

  it("shows official availability and the configured fallback order before creating a subscription", async () => {
    const preview = new SubscriptionPreviewService({
      resolve: async (input) => input.regionCode === "JP"
        ? { status: "official-available", officialPriceId: "70050000064985" }
        : unavailable("unsupported-region"),
    }, ["eshop-prices", "nt-deals"]);

    await expect(preview.create([jpCandidate, hkCandidate])).resolves.toEqual([
      expect.objectContaining({
        regionCode: "JP",
        officialStatus: "official-available",
        officialPriceId: "70050000064985",
        fallbackSources: ["eshop-prices", "nt-deals"],
        canMonitor: true,
        message: "官方价格可用",
      }),
      expect.objectContaining({
        regionCode: "HK",
        officialStatus: "official-id-unavailable",
        officialPriceId: null,
        fallbackSources: ["eshop-prices", "nt-deals"],
        canMonitor: true,
        message: expect.stringContaining("将使用第三方：eshop-prices → nt-deals"),
      }),
    ]);
  });

  it("marks a region as unmonitored when neither official nor third-party source is available", async () => {
    const preview = new SubscriptionPreviewService({ resolve: async () => unavailable("unsupported-region") }, []);

    await expect(preview.create([hkCandidate])).resolves.toEqual([
      expect.objectContaining({
        regionCode: "HK",
        officialStatus: "official-id-unavailable",
        officialPriceId: null,
        fallbackSources: [],
        canMonitor: false,
        message: "无可用价格来源，不会监控此区",
      }),
    ]);
  });
});

/** 构造已由搜索或手动链接确认的公开商品候选；价格 ID 是否可用由预览服务注入的解析器决定。 */
function candidate(regionCode: OfficialPriceIdCandidate["regionCode"], currency: string): OfficialPriceIdCandidate {
  return {
    regionCode,
    currency,
    productUrl: "https://example.test/product",
    canonicalTitle: "Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
  };
}

/** 统一构造安全的官方 ID 缺失结果，测试不依赖真实 URL 或外部错误信息。 */
function unavailable(reason: "unsupported-region" | "unrecognized-url" | "official-verification-failed"): OfficialPriceIdResolution {
  return { status: "official-id-unavailable", officialPriceId: null, reason };
}
