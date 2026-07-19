import { describe, expect, it } from "vitest";

import { formatCnyFen, formatDashboardDateTime, formatLocalPrice, trendPointsFor, type HistorySnapshot } from "../src/app/dashboard-view-model";

/** 展示纯函数测试防止组件因货币小数位或缺失汇率而擅自制造不可比较的价格趋势。 */
describe("dashboard view model", () => {
  it("formats JPY without decimal places and keeps CNY conversion explicitly approximate", () => {
    // 任天堂日区的金额最小单位就是日元；显示两位小数会制造不存在的店铺价格精度。
    expect(formatLocalPrice(1000, "JPY")).toBe("JP¥1,000");
    expect(formatLocalPrice(999, "USD")).toBe("US$9.99");
    expect(formatCnyFen(4174)).toBe("约 ¥41.74");
    expect(formatCnyFen(null)).toBe("人民币待换算");
  });

  it("formats UTC timestamps in the administrator's saved timezone", () => {
    // 采集和日报接口统一传输 UTC ISO 字符串；仪表盘必须按已保存时区显示，不能泄露 Z 后缀或依赖浏览器所在地区。
    expect(formatDashboardDateTime("2026-07-19T04:25:41.038Z", "Asia/Shanghai")).toBe("2026-07-19 12:25:41（Asia/Shanghai）");
  });

  it("keeps only CNY-comparable snapshots for an all-region trend", () => {
    // 全区折线不能混入汇率缺失快照；选择具体地区时仍只返回该区已经可换算的历史点。
    const snapshots: HistorySnapshot[] = [
      { regionCode: "JP", amountMinor: 1000, currency: "JPY", cnyFen: 4174, source: "official", capturedAt: "2026-07-17T00:00:00.000Z" },
      { regionCode: "US", amountMinor: 999, currency: "USD", cnyFen: null, source: "official", capturedAt: "2026-07-17T00:00:00.000Z" },
    ];

    expect(trendPointsFor(snapshots, null)).toEqual([{ capturedAt: "2026-07-17T00:00:00.000Z", cnyFen: 4174, regionCode: "JP" }]);
    expect(trendPointsFor(snapshots, "US")).toEqual([]);
  });
});
