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

/**
 * 所有字段先按 RFC 风格加倍内部双引号并整体包裹，保持逗号、CR/LF 等内容的单元格边界。
 * 字符串若以常见 ASCII、控制字符或日文环境可能识别的全角公式触发符开头，则前置单引号；
 * 这是降低电子表格误执行风险的输入中和措施，不声称能覆盖所有软件或导入配置。数字保持数字语义，负数不会被误加前缀。
 */
function csvCell(value: string | number | boolean): string {
  const neutralized = typeof value === "string" && /^[=+\-@\t\r\n＝＋－＠]/u.test(value)
    ? `'${value}`
    : String(value);
  return `"${neutralized.replaceAll('"', '""')}"`;
}
