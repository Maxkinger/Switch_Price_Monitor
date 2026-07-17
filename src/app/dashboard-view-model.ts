import type { HistorySnapshot } from "./dashboard-api-client";

export type { HistorySnapshot } from "./dashboard-api-client";

/** 趋势点只保留跨区可比较的人民币分和时间/地区维度，图表不需要持有完整快照或来源正文。 */
export interface TrendPoint {
  capturedAt: string;
  cnyFen: number;
  regionCode: string;
}

/**
 * 以任天堂商店的最小货币单位格式化本币。日元没有小数位，其余首版五区使用两位小数；
 * 未知币种保留代码，不臆造货币符号，避免将未来扩展地区错误显示为美元等已有货币。
 */
export function formatLocalPrice(amountMinor: number, currency: string): string {
  const fractionDigits = currency === "JPY" ? 0 : 2;
  const amount = amountMinor / (fractionDigits === 0 ? 1 : 100);
  const value = new Intl.NumberFormat("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(amount);
  const prefix = { USD: "US$", JPY: "JP¥", MXN: "MX$", BRL: "R$", HKD: "HK$" }[currency];
  return prefix ? `${prefix}${value}` : `${currency} ${value}`;
}

/**
 * 将 Worker 返回的人民币分转换为“约”值。汇率缺失时必须显式提示待换算，
 * 不能用 0 元、上一日汇率或浏览器请求外部汇率来填补，避免误导跨区比较。
 */
export function formatCnyFen(cnyFen: number | null): string {
  return cnyFen === null ? "人民币待换算" : `约 ¥${(cnyFen / 100).toFixed(2)}`;
}

/**
 * 生成趋势曲线可用点。全部地区模式只收录有人民币换算的快照，具体地区模式同样排除缺失换算，
 * 因而折线永远比较同一货币口径，而本币历史仍可由详情中的原始快照文字单独展示。
 */
export function trendPointsFor(snapshots: HistorySnapshot[], regionCode: string | null): TrendPoint[] {
  return snapshots.flatMap((snapshot) => {
    if ((regionCode !== null && snapshot.regionCode !== regionCode) || snapshot.cnyFen === null) return [];
    return [{ capturedAt: snapshot.capturedAt, cnyFen: snapshot.cnyFen, regionCode: snapshot.regionCode }];
  });
}
