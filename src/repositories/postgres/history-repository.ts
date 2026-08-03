import type { SqlExecutor } from "../../server/database/types";
import { buildHistoryResult, type HistoryResult, type HistoryRow } from "../../services/history-service";
import type { HistoryReader } from "../ports";

/** PostgreSQL 历史行的 TIMESTAMPTZ 由 pg 解码为 Date；其他字段已是服务允许的白名单业务值。 */
interface HistoryDatabaseRow extends Omit<HistoryRow, "capturedAt"> {
  capturedAt: Date | string;
}

/**
 * PostgreSQL 历史读取仓储按订阅归属返回不可变快照。
 * 订阅 ID 和可选地区都用 `$1/$2` 参数绑定，地址栏内容不能参与 SQL 结构或扩大到其他订阅数据。
 */
export class HistoryRepository implements HistoryReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async list(subscriptionId: string, region: string | null): Promise<HistoryResult> {
    const result = await this.database.query<HistoryDatabaseRow>(
      `SELECT products.region_code AS "regionCode",
              snapshots.amount_minor AS "amountMinor",
              snapshots.currency AS currency,
              snapshots.cny_fen AS "cnyFen",
              snapshots.source AS source,
              snapshots.captured_at AS "capturedAt"
         FROM price_snapshots AS snapshots
         INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
         INNER JOIN subscription_regions ON subscription_regions.regional_product_id = products.id
        WHERE subscription_regions.subscription_id = $1
          AND ($2::TEXT IS NULL OR products.region_code = $2)
        ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
      [subscriptionId, region],
    );
    return buildHistoryResult(result.rows.map((row) => ({ ...row, capturedAt: toIsoString(row.capturedAt) })));
  }
}

/** 历史 DTO 固定返回 UTC ISO 字符串，避免曲线排序受 Node/NAS 本地时区格式影响。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("价格历史时间无效。");
  return date.toISOString();
}
