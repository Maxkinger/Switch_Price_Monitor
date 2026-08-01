import type { SqlExecutor } from "../../server/database/types";
import type {
  NotificationEventReservation,
  NotificationEventStore,
  PendingNotificationEvent,
} from "../ports";

interface PendingEventRow extends Omit<PendingNotificationEvent, "createdAt"> {
  createdAt: Date;
}

/**
 * PostgreSQL 通知事件仓储。
 * `ON CONFLICT (dedupe_key) DO NOTHING` 依赖数据库唯一约束原子取得发送资格，
 * 避免先查后写竞态；查询只返回格式化所需字段，不读取 Token、Chat ID 或认证列。
 */
export class PostgresNotificationEventRepository implements NotificationEventStore {
  public constructor(private readonly database: SqlExecutor) {}

  public async reserve(event: NotificationEventReservation): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO notification_events (
         regional_product_id, event_type, status, dedupe_key, created_at
       ) VALUES ($1, $2, 'pending', $3, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [event.regionalProductId, event.eventType, event.dedupeKey, event.createdAt],
    );
    return result.rowCount === 1;
  }

  public async markDelivered(dedupeKey: string, sentAt: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE notification_events
          SET status = 'delivered', sent_at = $1
        WHERE dedupe_key = $2
          AND status = 'pending'`,
      [sentAt, dedupeKey],
    );
    return result.rowCount === 1;
  }

  public async pending(): Promise<PendingNotificationEvent[]> {
    const result = await this.database.query<PendingEventRow>(
      `SELECT notification_events.regional_product_id AS "regionalProductId",
              notification_events.event_type AS "eventType",
              notification_events.dedupe_key AS "dedupeKey",
              notification_events.created_at AS "createdAt",
              games.name_zh AS "gameNameZh",
              regional_products.region_code AS "regionCode"
         FROM notification_events
         LEFT JOIN regional_products
           ON regional_products.id = notification_events.regional_product_id
         LEFT JOIN games ON games.id = regional_products.game_id
        WHERE notification_events.status = 'pending'
        ORDER BY notification_events.created_at ASC, notification_events.id ASC`,
    );
    return result.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }
}
