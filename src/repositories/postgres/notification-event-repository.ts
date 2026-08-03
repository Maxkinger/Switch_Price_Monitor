import type { SqlExecutor } from "../../server/database/types";
import type { NotificationEventReservation, NotificationEventStore, PendingNotificationEvent } from "../ports";

/** pending 查询的内部行保留可空关联与驱动 Date；返回端口前统一转换为平台中立 DTO。 */
interface PendingNotificationEventRow {
  regionalProductId: string | null;
  eventType: PendingNotificationEvent["eventType"];
  dedupeKey: string;
  createdAt: Date | string;
  gameNameZh: string | null;
  regionCode: string | null;
}

/**
 * PostgreSQL 通知事件仓储以 dedupe_key 唯一约束原子取得发送资格。
 * 事件表只保存安全状态和时间，不存 Telegram Token、Chat ID、响应正文、Cookie 或外部错误原文。
 */
export class NotificationEventRepository implements NotificationEventStore {
  public constructor(private readonly database: SqlExecutor) {}

  /** 只忽略明确的 dedupe_key 冲突；外键和其他约束错误必须继续抛出，防止数据污染被误当成重复事件。 */
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

  /** 仅 pending 可转为 delivered；重复回调不会改写首次成功时间，也不能写入 Telegram 原始响应。 */
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

  /** pending 事件按创建时间与 BIGINT 主键稳定读取；已投递记录不会再次进入发送队列。 */
  public async pending(): Promise<PendingNotificationEvent[]> {
    const result = await this.database.query<PendingNotificationEventRow>(
      `SELECT notification_events.regional_product_id AS "regionalProductId",
              notification_events.event_type AS "eventType",
              notification_events.dedupe_key AS "dedupeKey",
              notification_events.created_at AS "createdAt",
              games.name_zh AS "gameNameZh",
              regional_products.region_code AS "regionCode"
         FROM notification_events
         LEFT JOIN regional_products ON regional_products.id = notification_events.regional_product_id
         LEFT JOIN games ON games.id = regional_products.game_id
        WHERE notification_events.status = 'pending'
        ORDER BY notification_events.created_at ASC, notification_events.id ASC`,
    );
    return result.rows.map((row) => ({ ...row, createdAt: toIsoString(row.createdAt) }));
  }
}

/** TIMESTAMPTZ 必须统一为 UTC ISO 字符串，确保通知去重、排序和调度日志不受 NAS 本地时区影响。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("通知事件创建时间无效。");
  return date.toISOString();
}
