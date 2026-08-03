import type { SqlExecutor } from "../../server/database/types";
import {
  formatFetchLogsCsv,
  formatPricesCsv,
  formatSubscriptionsCsv,
  type FetchLogExportRow,
  type PriceExportRow,
  type SubscriptionExportRow,
} from "../../services/export-service";
import type { ExportReader } from "../ports";

/** PostgreSQL 价格导出行只把 TIMESTAMPTZ 保留为驱动类型；认证和通知列不存在于该模型。 */
interface PriceExportDatabaseRow extends Omit<PriceExportRow, "capturedAt"> {
  capturedAt: Date | string;
}

/** PostgreSQL 原生 BOOLEAN 在仓储映射为既有 CSV 的 0/1，避免数据库迁移无意改变备份文件契约。 */
interface SubscriptionExportDatabaseRow extends Omit<SubscriptionExportRow, "enabled"> {
  enabled: boolean;
}

/** 可空商品联接与可空消息保持原义，TIMESTAMPTZ 在 CSV 格式化前转成 UTC ISO。 */
interface FetchLogExportDatabaseRow extends Omit<FetchLogExportRow, "capturedAt"> {
  capturedAt: Date | string;
}

/**
 * PostgreSQL CSV 读取仓储为三种用途维护独立固定列白名单。
 * 不提供通用表名、动态列或 SELECT *，确保密码、恢复码、会话和 Telegram 配置永远不能进入导出。
 */
export class ExportRepository implements ExportReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async pricesCsv(): Promise<string> {
    const result = await this.database.query<PriceExportDatabaseRow>(
      `SELECT products.region_code AS "regionCode",
              snapshots.amount_minor AS "amountMinor",
              snapshots.currency AS currency,
              snapshots.cny_fen AS "cnyFen",
              snapshots.source AS source,
              snapshots.captured_at AS "capturedAt"
         FROM price_snapshots AS snapshots
         INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
        ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
    );
    return formatPricesCsv(result.rows.map((row) => ({ ...row, capturedAt: toIsoString(row.capturedAt) })));
  }

  public async subscriptionsCsv(): Promise<string> {
    const result = await this.database.query<SubscriptionExportDatabaseRow>(
      `SELECT subscriptions.id AS "subscriptionId",
              subscriptions.game_id AS "gameId",
              subscriptions.enabled AS enabled,
              products.region_code AS "regionCode",
              products.id AS "regionalProductId"
         FROM subscriptions
         LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
         LEFT JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
        ORDER BY subscriptions.created_at ASC, products.region_code ASC`,
    );
    return formatSubscriptionsCsv(result.rows.map((row) => ({ ...row, enabled: row.enabled ? 1 : 0 })));
  }

  public async fetchLogsCsv(): Promise<string> {
    const result = await this.database.query<FetchLogExportDatabaseRow>(
      `SELECT products.region_code AS "regionCode",
              logs.source AS source,
              logs.status AS status,
              logs.message AS message,
              logs.captured_at AS "capturedAt"
         FROM fetch_logs AS logs
         LEFT JOIN regional_products AS products ON products.id = logs.regional_product_id
        ORDER BY logs.captured_at ASC, logs.id ASC`,
    );
    return formatFetchLogsCsv(result.rows.map((row) => ({ ...row, capturedAt: toIsoString(row.capturedAt) })));
  }
}

/** CSV 时间必须是 UTC ISO 字符串；直接 String(Date) 会产生宿主时区英文文本并破坏跨环境备份比较。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("导出时间无效。");
  return date.toISOString();
}
