/** 导出行仅列出价格分析所需字段，服务中不存在认证或第三方密钥列，避免未来 SELECT * 泄露秘密。 */
interface PriceExportRow { regionCode: string; amountMinor: number; currency: string; cnyFen: number | null; source: string; capturedAt: string; }

/** CSV 导出服务；首版只开放价格历史，其他导出类型会在各自字段白名单和分页策略完成后加入。 */
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
}

/** 将引号包裹和双引号转义集中处理，防止未来文本来源或时间字段破坏 CSV 列边界。 */
function csvCell(value: string | number): string { return `"${String(value).replaceAll('"', '""')}"`; }
