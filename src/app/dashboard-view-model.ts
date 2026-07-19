import type { HistorySnapshot } from "./dashboard-api-client";

export type { HistorySnapshot } from "./dashboard-api-client";

/** 趋势点只保留跨区可比较的人民币分和时间/地区维度，图表不需要持有完整快照或来源正文。 */
export interface TrendPoint {
  capturedAt: string;
  cnyFen: number;
  regionCode: string;
}

/**
 * 已确认的五个监控地区的中文名称。地区代码是 Worker 与数据库之间稳定的机器字段，
 * 仅在展示层翻译，避免改变订阅、采集和价格来源接口的既有数据契约。
 */
const REGION_NAMES: Record<string, string> = {
  US: "美国区",
  MX: "墨西哥区",
  JP: "日本区",
  BR: "巴西区",
  HK: "香港区",
};

/**
 * 返回管理员确认的地区中文名称；尚未纳入五区范围的代码必须原样保留。
 * 原样回退让新增地区在没有本地化决策时仍可识别，也避免展示层猜测国家或地区名称。
 */
export function formatRegionName(regionCode: string): string {
  return REGION_NAMES[regionCode] ?? regionCode;
}

/**
 * 使用旧版安全规则格式化未确认地区，避免把未来币种或异常地区误显示为五区任一官方样式。
 * 日元最小单位是日元本身，其余现有货币以分为最小单位；未知币种仅显示其代码，不能臆造符号。
 */
function formatFallbackLocalPrice(amountMinor: number, currency: string): string {
  const fractionDigits = currency === "JPY" ? 0 : 2;
  const amount = amountMinor / (fractionDigits === 0 ? 1 : 100);
  const value = new Intl.NumberFormat("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(amount);
  const prefix = { USD: "US$", JPY: "JP¥", MXN: "MX$", BRL: "R$", HKD: "HK$" }[currency];
  return prefix ? `${prefix}${value}` : `${currency} ${value}`;
}

/**
 * 按地区官网已确认的文案展示本币金额。地区与币种必须同时匹配，防止采集异常时把错误币种包装成官方价；
 * 例如 US/MX 都显示 "$"，其地区语义由紧邻的中文名称表达。香港仅在金额为整数时省略小数，
 * 日区固定追加“円（税込）”，以保持管理员确认的官方阅读口径。
 */
export function formatRegionalPrice(amountMinor: number, currency: string, regionCode: string): string {
  if (regionCode === "US" && currency === "USD") return `$ ${(amountMinor / 100).toFixed(2)}`;
  if (regionCode === "MX" && currency === "MXN") return `$ ${(amountMinor / 100).toFixed(2)}`;
  if (regionCode === "JP" && currency === "JPY") return `${new Intl.NumberFormat("en-US").format(amountMinor)} 円（税込）`;
  if (regionCode === "BR" && currency === "BRL") return `R$ ${(amountMinor / 100).toFixed(2)}`;
  if (regionCode === "HK" && currency === "HKD") {
    const amount = amountMinor / 100;
    return `HKD ${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)}`;
  }

  return formatFallbackLocalPrice(amountMinor, currency);
}

/**
 * 将 Worker 返回的人民币分转换为“约”值。汇率缺失时必须显式提示待换算，
 * 不能用 0 元、上一日汇率或浏览器请求外部汇率来填补，避免误导跨区比较。
 */
export function formatCnyFen(cnyFen: number | null): string {
  return cnyFen === null ? "人民币待换算" : `约 ¥${(cnyFen / 100).toFixed(2)}`;
}

/**
 * 把 Worker 统一传输的 UTC ISO 时刻转成管理员保存时区中的固定中文可读格式。
 * 使用 formatToParts 而非浏览器默认 locale，避免不同设备把日期顺序、12 小时制或秒数展示成不同结果；
 * timezone 来自服务端已验证的 IANA 设置，调用方在设置尚未初始化时显式传入 UTC，不依赖浏览器本地时区。
 */
export function formatDashboardDateTime(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}（${timezone}）`;
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
