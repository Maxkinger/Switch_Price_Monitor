import type { ExportReader } from "../repositories/ports";

/** CSV 导出服务只格式化固定 reader 行；仓储查询不得包含认证或 Telegram 列。 */
export class ExportService {
  public constructor(private readonly exports: ExportReader) {}

  public async pricesCsv(): Promise<string> {
    const rows = (await this.exports.prices())
      .map((row) => [row.regionCode, row.amountMinor, row.currency, row.cnyFen ?? "", row.source, row.capturedAt].map(csvCell).join(","));
    return ["region_code,amount_minor,currency,cny_fen,source,captured_at", ...rows].join("\r\n");
  }

  /** 订阅 CSV 仅含监控配置和原生布尔状态，不含管理员、会话或外部来源凭据。 */
  public async subscriptionsCsv(): Promise<string> {
    const rows = (await this.exports.subscriptions())
      .map((row) => [row.subscriptionId, row.gameId, row.enabled, row.regionCode ?? "", row.regionalProductId ?? ""].map(csvCell).join(","));
    return ["subscription_id,game_id,enabled,region_code,regional_product_id", ...rows].join("\r\n");
  }

  /** 日志 CSV 只含脱敏诊断摘要；消息仍执行 CSV 引号转义，不能破坏列边界。 */
  public async fetchLogsCsv(): Promise<string> {
    const rows = (await this.exports.fetchLogs())
      .map((row) => [row.regionCode ?? "", row.source, row.status, row.message ?? "", row.capturedAt].map(csvCell).join(","));
    return ["region_code,source,status,message,captured_at", ...rows].join("\r\n");
  }
}

/** 所有字段统一引号包裹并把内部双引号加倍，防止公式样式文本或逗号改变 CSV 结构。 */
function csvCell(value: string | number | boolean): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}
