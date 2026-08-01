import type { SqlExecutor } from "../../server/database/types";
import type { HistoryReader, HistorySnapshot } from "../ports";

interface HistoryRow extends Omit<HistorySnapshot, "capturedAt"> { capturedAt: Date; }

/**
 * PostgreSQL 价格历史 reader。
 * 订阅和可选地区均通过参数绑定，`$2 IS NULL` 保持既有全区语义；
 * 同时间按 BIGINT identity 升序稳定返回，但不把 identity 暴露或转换到 JavaScript。
 */
export class PostgresHistoryRepository implements HistoryReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async list(subscriptionId: string, region: string | null): Promise<{ snapshots: HistorySnapshot[] }> {
    const result = await this.database.query<HistoryRow>(
      `SELECT products.region_code AS "regionCode",
              snapshots.amount_minor AS "amountMinor",
              snapshots.currency,
              snapshots.cny_fen AS "cnyFen",
              snapshots.source,
              snapshots.captured_at AS "capturedAt"
         FROM price_snapshots AS snapshots
         INNER JOIN regional_products AS products
           ON products.id = snapshots.regional_product_id
         INNER JOIN subscription_regions
           ON subscription_regions.regional_product_id = products.id
        WHERE subscription_regions.subscription_id = $1
          AND ($2::text IS NULL OR products.region_code = $2)
        ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
      [subscriptionId, region],
    );
    return { snapshots: result.rows.map((row) => ({ ...row, capturedAt: row.capturedAt.toISOString() })) };
  }
}
