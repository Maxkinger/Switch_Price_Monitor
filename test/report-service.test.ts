import { describe, expect, it } from "vitest";

import { buildDailyReport, type DailyReportSubscription } from "../src/worker/services/report-service";

describe("daily Telegram report formatter", () => {
  it("includes source-marked current prices and both kinds of historical lows", () => {
    // 日报必须同时让管理员比较当前价、跨区人民币最低价和各区本币最低价；第三方价格不可伪装为官方来源。
    const messages = buildDailyReport({
      timezone: "Asia/Shanghai",
      generatedAt: "2026-07-16T01:00:00.000Z",
      subscriptions: [buildSubscription("胡闹厨房 2")],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("第三方：eShop-Prices");
    expect(messages[0].text).toContain("全区历史最低：日本区 JP¥1,000（约 ¥42.00，2026-07-14）");
    expect(messages[0].text).toContain("美国区：US$9.99（约 ¥68.00，2026-07-15）");
  });

  it("splits a long report below Telegram's message limit and labels every page", () => {
    // Telegram 单条消息有硬性长度上限；分页时不能遗失任一订阅，也必须让用户在聊天里看得出消息顺序。
    const messages = buildDailyReport({
      timezone: "Asia/Shanghai",
      generatedAt: "2026-07-16T01:00:00.000Z",
      subscriptions: Array.from({ length: 60 }, (_, index) => buildSubscription(`价格监控测试商品 ${index + 1} ${"很长的标题".repeat(12)}`)),
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.text.length <= 4096)).toBe(true);
    expect(messages[0].text).toContain(`第 1/${messages.length} 页`);
    expect(messages.at(-1)?.text).toContain(`第 ${messages.length}/${messages.length} 页`);
  });
});

function buildSubscription(nameZh: string): DailyReportSubscription {
  // 使用一官方一区第三方的固定夹具，验证日报不会因币种不同而丢失原始货币、人民币或来源展示。
  return {
    subscriptionId: `subscription-${nameZh}`,
    nameZh,
    enabled: true,
    allRegionHistoricalLow: {
      regionalProductId: "product-jp",
      regionCode: "JP",
      amountMinor: 1000,
      currency: "JPY",
      cnyFen: 4200,
      source: "official",
      capturedAt: "2026-07-14T00:00:00.000Z",
    },
    regions: [
      {
        regionalProductId: "product-us",
        regionCode: "US",
        currency: "USD",
        current: { amountMinor: 1099, cnyFen: 7450, source: "eshop-prices", capturedAt: "2026-07-16T01:00:00.000Z" },
        historicalLow: { amountMinor: 999, cnyFen: 6800, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
      },
      {
        regionalProductId: "product-jp",
        regionCode: "JP",
        currency: "JPY",
        current: { amountMinor: 1000, cnyFen: 4200, source: "official", capturedAt: "2026-07-16T01:00:00.000Z" },
        historicalLow: { amountMinor: 1000, cnyFen: 4200, source: "official", capturedAt: "2026-07-14T00:00:00.000Z" },
      },
    ],
  };
}
