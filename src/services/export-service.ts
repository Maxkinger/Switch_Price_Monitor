import type { ExportReader } from "../repositories/ports";

/** 价格导出白名单只包含分析字段；认证、通知、内部主键和外部响应不属于该模型。 */
export interface PriceExportRow {
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number | null;
  source: string;
  capturedAt: string;
}

/** 订阅导出允许空地区联接；enabled 固定为旧 CSV 契约的 0/1，而不是数据库方言相关布尔文本。 */
export interface SubscriptionExportRow {
  subscriptionId: string;
  gameId: string;
  enabled: number;
  regionCode: string | null;
  regionalProductId: string | null;
}

/** 诊断日志导出只含脱敏摘要；地区商品删除后 regionCode 可空，消息仍必须经过 CSV 转义。 */
export interface FetchLogExportRow {
  regionCode: string | null;
  source: string;
  status: string;
  message: string | null;
  capturedAt: string;
}

/**
 * CSV 服务只委托三个固定读取方法，不接受表名、列名或通用查询输入。
 * 固定端口使未来认证、会话或 Telegram 字段即使新增，也不能通过调用参数进入任何导出。
 */
export class ExportService {
  public constructor(private readonly reader: ExportReader) {}

  public async pricesCsv(): Promise<string> {
    return this.reader.pricesCsv();
  }

  public async subscriptionsCsv(): Promise<string> {
    return this.reader.subscriptionsCsv();
  }

  public async fetchLogsCsv(): Promise<string> {
    return this.reader.fetchLogsCsv();
  }
}

/** 价格 CSV 使用固定列顺序和 CRLF，人民币缺失保持空单元格而不是零。 */
export function formatPricesCsv(rows: PriceExportRow[]): string {
  return [
    "region_code,amount_minor,currency,cny_fen,source,captured_at",
    ...rows.map((row) => [row.regionCode, row.amountMinor, row.currency, row.cnyFen ?? "", row.source, row.capturedAt].map(csvCell).join(",")),
  ].join("\r\n");
}

/** 订阅 CSV 只导出监控配置；空地区保持两个空单元格，BOOLEAN 已由仓储明确映射为兼容的 0/1。 */
export function formatSubscriptionsCsv(rows: SubscriptionExportRow[]): string {
  return [
    "subscription_id,game_id,enabled,region_code,regional_product_id",
    ...rows.map((row) => [row.subscriptionId, row.gameId, row.enabled, row.regionCode ?? "", row.regionalProductId ?? ""].map(csvCell).join(",")),
  ].join("\r\n");
}

/** 诊断日志 CSV 不含原始响应、令牌或 Cookie；可空地区和消息统一为空单元格并执行标准转义。 */
export function formatFetchLogsCsv(rows: FetchLogExportRow[]): string {
  return [
    "region_code,source,status,message,captured_at",
    ...rows.map((row) => [row.regionCode ?? "", row.source, row.status, row.message ?? "", row.capturedAt].map(csvCell).join(",")),
  ].join("\r\n");
}

/** 将引号包裹和双引号转义集中处理，防止文本来源、日志摘要或时间字段破坏 CSV 列边界。 */
function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}
