import type { SqlExecutor } from "../../server/database/types";
import type {
  ExportReader,
  FetchLogExportRow,
  PriceExportRow,
  SubscriptionExportRow,
} from "../ports";

interface PriceRow extends Omit<PriceExportRow, "capturedAt"> { capturedAt: Date; }
interface FetchLogRow extends Omit<FetchLogExportRow, "capturedAt"> { capturedAt: Date; }

/**
 * PostgreSQL CSV 安全行 reader。
 * 三个查询都使用显式列白名单，绝不 SELECT * 或联接认证、会话、设置秘密及 Telegram 配置；
 * BIGINT identity 仅用于同时间稳定排序，CSV 服务只接收平台中立值。
 */
export class PostgresExportRepository implements ExportReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async prices(): Promise<PriceExportRow[]> {
    const result = await this.database.query<PriceRow>(
      `SELECT products.region_code AS "regionCode",
              snapshots.amount_minor AS "amountMinor",
              snapshots.currency,
              snapshots.cny_fen AS "cnyFen",
              snapshots.source,
              snapshots.captured_at AS "capturedAt"
         FROM price_snapshots AS snapshots
         INNER JOIN regional_products AS products
           ON products.id = snapshots.regional_product_id
        ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
    );
    return result.rows.map((row) => ({ ...row, capturedAt: row.capturedAt.toISOString() }));
  }

  public async subscriptions(): Promise<SubscriptionExportRow[]> {
    const result = await this.database.query<SubscriptionExportRow>(
      `SELECT subscriptions.id AS "subscriptionId",
              subscriptions.game_id AS "gameId",
              subscriptions.enabled,
              products.region_code AS "regionCode",
              products.id AS "regionalProductId"
         FROM subscriptions
         LEFT JOIN subscription_regions
           ON subscription_regions.subscription_id = subscriptions.id
         LEFT JOIN regional_products AS products
           ON products.id = subscription_regions.regional_product_id
        ORDER BY subscriptions.created_at ASC, products.region_code ASC, products.id ASC`,
    );
    return result.rows;
  }

  public async fetchLogs(): Promise<FetchLogExportRow[]> {
    const result = await this.database.query<FetchLogRow>(
      `SELECT products.region_code AS "regionCode",
              logs.source,
              logs.status,
              logs.message,
              logs.captured_at AS "capturedAt"
         FROM fetch_logs AS logs
         LEFT JOIN regional_products AS products
           ON products.id = logs.regional_product_id
        ORDER BY logs.captured_at ASC, logs.id ASC`,
    );
    return result.rows.map((row) => ({ ...row, capturedAt: row.capturedAt.toISOString() }));
  }
}
