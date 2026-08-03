import type { NotificationEventReservation, PendingNotificationEvent } from "./ports";

// 迁移期间从旧仓储路径重导出平台中立通知 DTO，保证尚未切换的 Worker 调度测试无需同步改动行为。
export type { NotificationEventReservation, PendingNotificationEvent } from "./ports";

/**
 * 通知事件的 D1 去重边界。唯一键由业务层以地区商品、事件类型和状态变迁时刻组成，
 * 即使 Cron 重试或多个 Worker 重叠，数据库也只会允许一次待发送记录，防止 Telegram 重复打扰管理员。
 */
export class NotificationEventRepository {
  public constructor(private readonly database: D1Database) {}

  /**
   * 尝试为一个业务事件取得发送资格。INSERT OR IGNORE 依赖 dedupe_key 的唯一约束原子完成判断，
   * 不使用先查询再插入的方式，以免并发调用都认为事件不存在；false 表示已有同一事件，调用方不得再次发送。
   */
  public async reserve(event: NotificationEventReservation): Promise<boolean> {
    const result = await this.database
      .prepare(
        `INSERT OR IGNORE INTO notification_events (
          regional_product_id, event_type, status, dedupe_key, created_at
        ) VALUES (?, ?, 'pending', ?, ?)`,
      )
      .bind(event.regionalProductId, event.eventType, event.dedupeKey, event.createdAt)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * 标记一次已经确认成功的投递。仅 pending 记录可转换为 delivered，
   * 使重复回调或重试无法改写第一次成功的审计时间；调用方不得把 Telegram 原始响应写入本表。
   */
  public async markDelivered(dedupeKey: string, sentAt: string): Promise<boolean> {
    const result = await this.database
      .prepare("UPDATE notification_events SET status = 'delivered', sent_at = ? WHERE dedupe_key = ? AND status = 'pending'")
      .bind(sentAt, dedupeKey)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * 按创建时间稳定读取待投递事件。已 delivered 的事件不会再次返回，
   * 因此发送器可以在单次 Cron 中顺序投递并逐条确认，不会重复发送成功消息。
   */
  public async pending(): Promise<PendingNotificationEvent[]> {
    const result = await this.database
      .prepare(
        `SELECT notification_events.regional_product_id AS regionalProductId,
                notification_events.event_type AS eventType,
                notification_events.dedupe_key AS dedupeKey,
                notification_events.created_at AS createdAt,
                games.name_zh AS gameNameZh,
                regional_products.region_code AS regionCode
         FROM notification_events
         LEFT JOIN regional_products ON regional_products.id = notification_events.regional_product_id
         LEFT JOIN games ON games.id = regional_products.game_id
         WHERE notification_events.status = 'pending'
         ORDER BY notification_events.created_at ASC, notification_events.id ASC`,
      )
      .all<PendingNotificationEvent>();
    return result.results;
  }
}
