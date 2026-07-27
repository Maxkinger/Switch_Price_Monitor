/** 导出行仅列出价格分析所需字段，服务中不存在认证或第三方密钥列，避免未来 SELECT * 泄露秘密。 */
interface PriceExportRow { regionCode: string; amountMinor: number; currency: string; cnyFen: number | null; source: string; capturedAt: string; }

/** CSV 导出服务；每个种类独立查询与字段白名单，严禁复用可能包含秘密字段的管理查询。 */
export class ExportService {
  public constructor(private readonly database: D1Database) {}
  public async pricesCsv(): Promise<string> {
    const result = await this.database.prepare(
      `SELECT products.region_code AS regionCode, snapshots.amount_minor AS amountMinor, snapshots.currency AS currency,
              snapshots.cny_fen AS cnyFen, snapshots.source AS source, snapshots.captured_at AS capturedAt
       FROM price_snapshots AS snapshots INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
       ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
    ).all<PriceExportRow>();
    const rows = result.results.map((row) => [row.regionCode, row.amountMinor, row.currency, row.cnyFen ?? "", row.source, row.capturedAt].map(csvCell).join(","));
    return ["region_code,amount_minor,currency,cny_fen,source,captured_at", ...rows].join("\r\n");
  }

  /** 导出订阅配置与已确认地区商品，不含管理员、密码或会话字段，方便管理员备份监控范围。 */
  public async subscriptionsCsv(): Promise<string> {
    const result = await this.database.prepare(
      `SELECT subscriptions.id AS subscriptionId, subscriptions.game_id AS gameId, subscriptions.enabled AS enabled,
              products.region_code AS regionCode, products.id AS regionalProductId
       FROM subscriptions LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
       LEFT JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
       ORDER BY subscriptions.created_at ASC, products.region_code ASC`,
    ).all<{ subscriptionId: string; gameId: string; enabled: number; regionCode: string | null; regionalProductId: string | null }>();
    return ["subscription_id,game_id,enabled,region_code,regional_product_id", ...result.results.map((row) => [row.subscriptionId, row.gameId, row.enabled, row.regionCode ?? "", row.regionalProductId ?? ""].map(csvCell).join(","))].join("\r\n");
  }

  /** 导出可诊断的安全日志摘要；日志消息经 CSV 转义，但不含原始外部响应、令牌或 Cookie。 */
  public async fetchLogsCsv(): Promise<string> {
    const result = await this.database.prepare(
      `SELECT products.region_code AS regionCode, logs.source AS source, logs.status AS status, logs.message AS message, logs.captured_at AS capturedAt
       FROM fetch_logs AS logs LEFT JOIN regional_products AS products ON products.id = logs.regional_product_id
       ORDER BY logs.captured_at ASC, logs.id ASC`,
    ).all<{ regionCode: string | null; source: string; status: string; message: string | null; capturedAt: string }>();
    return ["region_code,source,status,message,captured_at", ...result.results.map((row) => [row.regionCode ?? "", row.source, row.status, row.message ?? "", row.capturedAt].map(csvCell).join(","))].join("\r\n");
  }
}

/** 将引号包裹和双引号转义集中处理，防止未来文本来源或时间字段破坏 CSV 列边界。 */
function csvCell(value: string | number): string { return `"${String(value).replaceAll('"', '""')}"`; }
