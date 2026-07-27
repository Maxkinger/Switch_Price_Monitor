/** 价格历史行只含展示和导出所需字段；不返回内部快照 ID、数据库时间或任何认证资料。 */
interface HistoryRow { regionCode: string; amountMinor: number; currency: string; cnyFen: number | null; source: string; capturedAt: string; }

/** 按订阅读取不可变快照，所有筛选值通过 D1 参数绑定，避免查询字符串参与 SQL 拼接。 */
export class HistoryService {
  public constructor(private readonly database: D1Database) {}
  public async list(subscriptionId: string, region: string | null): Promise<{ snapshots: HistoryRow[] }> {
    const result = await this.database.prepare(
      `SELECT products.region_code AS regionCode, snapshots.amount_minor AS amountMinor, snapshots.currency AS currency,
              snapshots.cny_fen AS cnyFen, snapshots.source AS source, snapshots.captured_at AS capturedAt
       FROM price_snapshots AS snapshots
       INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
       INNER JOIN subscription_regions ON subscription_regions.regional_product_id = products.id
       WHERE subscription_regions.subscription_id = ? AND (? IS NULL OR products.region_code = ?)
       ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
    ).bind(subscriptionId, region, region).all<HistoryRow>();
    return { snapshots: result.results };
  }
}
