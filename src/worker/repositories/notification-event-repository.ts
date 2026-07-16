/** 预留通知事件所需的最小公开数据；不允许调用方传入消息正文、Token、Chat ID 或任意状态值。 */
export interface NotificationEventReservation {
  regionalProductId: string | null;
  eventType: "collection-failure" | "collection-recovered" | "official-price-drop" | "target-price";
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
}
