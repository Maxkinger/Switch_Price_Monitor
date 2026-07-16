/** 预留通知事件所需的最小公开数据；不允许调用方传入消息正文、Token、Chat ID 或任意状态值。 */
export interface NotificationEventReservation {
  regionalProductId: string | null;
  eventType: "collection-failure" | "collection-recovered" | "official-price-drop" | "target-price";
  dedupeKey: string;
  createdAt: string;
}

/** 待发送读取模型只暴露格式化和确认投递需要的字段，隐藏自增主键及任何未来内部审计列。 */
export interface PendingNotificationEvent {
  regionalProductId: string | null;
  eventType: NotificationEventReservation["eventType"];
  dedupeKey: string;
  createdAt: string;
}

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
        `SELECT regional_product_id AS regionalProductId, event_type AS eventType,
                dedupe_key AS dedupeKey, created_at AS createdAt
         FROM notification_events
         WHERE status = 'pending'
         ORDER BY created_at ASC, id ASC`,
      )
      .all<PendingNotificationEvent>();
    return result.results;
  }
}
