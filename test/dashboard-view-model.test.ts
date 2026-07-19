import { describe, expect, it } from "vitest";

import * as dashboardViewModel from "../src/app/dashboard-view-model";
import { formatCnyFen, formatDashboardDateTime, trendPointsFor, type HistorySnapshot } from "../src/app/dashboard-view-model";

/**
 * 在共享格式化函数尚未实现前，以可选接口描述待交付能力。
 * 这样 RED 阶段会因断言失败而非模块导入错误停止；实现完成后，同一测试会继续校验完整业务文字。
 */
interface LocalizedPriceViewModel {
  formatRegionName?: (regionCode: string) => string;
  formatRegionalPrice?: (amountMinor: number, currency: string, regionCode: string) => string;
}

const localizedPriceViewModel = dashboardViewModel as LocalizedPriceViewModel;

/** 展示纯函数测试防止组件因货币小数位或缺失汇率而擅自制造不可比较的价格趋势。 */
describe("dashboard view model", () => {
  it("uses confirmed Chinese region names and official regional price copy", () => {
    // US 与 MX 都只显示官方页面的 "$"；地区语义必须由相邻中文名称承担，不能擅自添加未确认前缀。
    expect(localizedPriceViewModel.formatRegionName).toBeTypeOf("function");
    expect(localizedPriceViewModel.formatRegionalPrice).toBeTypeOf("function");

    const formatRegionName = localizedPriceViewModel.formatRegionName!;
    const formatRegionalPrice = localizedPriceViewModel.formatRegionalPrice!;

    expect(formatRegionName("US")).toBe("美国区");
    expect(formatRegionName("MX")).toBe("墨西哥区");
    expect(formatRegionName("JP")).toBe("日本区");
    expect(formatRegionName("BR")).toBe("巴西区");
    expect(formatRegionName("HK")).toBe("香港区");
    expect(formatRegionName("CA")).toBe("CA");
    expect(formatRegionalPrice(3999, "USD", "US")).toBe("$ 39.99");
    expect(formatRegionalPrice(3999, "MXN", "MX")).toBe("$ 39.99");
    expect(formatRegionalPrice(1999, "JPY", "JP")).toBe("1,999 円（税込）");
    expect(formatRegionalPrice(9900, "BRL", "BR")).toBe("R$ 99.00");
    expect(formatRegionalPrice(19800, "HKD", "HK")).toBe("HKD 198");
    expect(formatRegionalPrice(1299, "CAD", "CA")).toBe("CAD 12.99");
  });

  it("keeps CNY conversion explicitly approximate", () => {
    // 汇率是采集快照的一部分；缺失时不能用 0 元或浏览器即时汇率伪造可比较金额。
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
