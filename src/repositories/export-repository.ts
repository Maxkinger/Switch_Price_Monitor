import type {
  FetchLogExportRow,
  PriceExportRow,
  SubscriptionExportRow,
} from "./ports";

/**
 * 临时 D1 导出 reader 只用于最终 Worker 移除前维持现有只读路由。
 * 每种导出仍使用独立字段白名单；新 Node 路径改由 PostgreSQL reader 提供同样安全行。
 */
export class LegacyExportRepository {
  public constructor(private readonly database: D1Database) {}
  public async prices(): Promise<PriceExportRow[]> {
    const result = await this.database.prepare(
      `SELECT products.region_code AS regionCode, snapshots.amount_minor AS amountMinor, snapshots.currency AS currency,
              snapshots.cny_fen AS cnyFen, snapshots.source AS source, snapshots.captured_at AS capturedAt
       FROM price_snapshots AS snapshots INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
       ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
    ).all<PriceExportRow>();
    return result.results;
  }

  /** 导出订阅配置与已确认地区商品，不含管理员、密码或会话字段，方便管理员备份监控范围。 */
  public async subscriptions(): Promise<SubscriptionExportRow[]> {
    const result = await this.database.prepare(
      `SELECT subscriptions.id AS subscriptionId, subscriptions.game_id AS gameId, subscriptions.enabled AS enabled,
              products.region_code AS regionCode, products.id AS regionalProductId
       FROM subscriptions LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
       LEFT JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
       ORDER BY subscriptions.created_at ASC, products.region_code ASC`,
    ).all<{ subscriptionId: string; gameId: string; enabled: number; regionCode: string | null; regionalProductId: string | null }>();
    return result.results.map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  /** 导出可诊断的安全日志摘要；日志消息经 CSV 转义，但不含原始外部响应、令牌或 Cookie。 */
  public async fetchLogs(): Promise<FetchLogExportRow[]> {
    const result = await this.database.prepare(
      `SELECT products.region_code AS regionCode, logs.source AS source, logs.status AS status, logs.message AS message, logs.captured_at AS capturedAt
       FROM fetch_logs AS logs LEFT JOIN regional_products AS products ON products.id = logs.regional_product_id
       ORDER BY logs.captured_at ASC, logs.id ASC`,
    ).all<FetchLogExportRow>();
    return result.results;
  }
}
