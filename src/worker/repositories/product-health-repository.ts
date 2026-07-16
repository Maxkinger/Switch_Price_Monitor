import type { ProductHealthState } from "../services/price-rules";

/** D1 行模型把整数标记转换前保留在仓储内，避免上层将 SQLite 的 0/1 当作业务布尔值处理。 */
interface ProductHealthRow {
  consecutiveFailures: number;
  failureNotified: number;
}

/**
 * 地区商品健康状态的持久化边界。该仓储只保存通知去重所需的最小状态，
 * 不保存第三方响应、错误堆栈或 Telegram 凭据，确保运维数据可长期排查而不扩大敏感面。
 */
export class ProductHealthRepository {
  public constructor(private readonly database: D1Database) {}

  /** 没有健康行代表从未失败，按零失败且未通知处理，避免首次采集被误判为恢复。 */
  public async get(regionalProductId: string): Promise<ProductHealthState> {
    const row = await this.database
      .prepare("SELECT consecutive_failures AS consecutiveFailures, failure_notified AS failureNotified FROM regional_product_health WHERE regional_product_id = ?")
      .bind(regionalProductId)
      .first<ProductHealthRow>();
    return row ? { consecutiveFailures: row.consecutiveFailures, failureNotified: row.failureNotified === 1 } : { consecutiveFailures: 0, failureNotified: false };
  }

  /**
   * 通过 UPSERT 保存一轮已计算的状态。成功时间仅在本轮采集成功时更新，
   * 失败不会覆盖最近成功证据；调用方必须按单地区商品顺序执行，以配合后续通知事件唯一键完成跨 Cron 去重。
   */
  public async save(regionalProductId: string, state: ProductHealthState, lastSuccessAt: string | null, updatedAt: string): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(regional_product_id) DO UPDATE SET
           consecutive_failures = excluded.consecutive_failures,
           last_success_at = COALESCE(excluded.last_success_at, regional_product_health.last_success_at),
           failure_notified = excluded.failure_notified,
           updated_at = excluded.updated_at`,
      )
      .bind(regionalProductId, state.consecutiveFailures, lastSuccessAt, state.failureNotified ? 1 : 0, updatedAt)
      .run();
  }
}
