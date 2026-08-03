import type { SqlExecutor } from "../../server/database/types";
import type { ProductHealthState } from "../../services/price-rules";
import type { ProductHealthStore } from "../ports";

/** PostgreSQL 健康行使用原生 BOOLEAN，仓储不再执行 SQLite 0/1 到布尔值的隐式约定。 */
interface ProductHealthRow {
  consecutiveFailures: number;
  failureNotified: boolean;
}

/**
 * PostgreSQL 地区商品健康仓储保存通知去重所需的最小状态。
 * 不保存错误堆栈、外部响应或 Telegram 配置，避免长期诊断数据扩大敏感信息面。
 */
export class ProductHealthRepository implements ProductHealthStore {
  public constructor(private readonly database: SqlExecutor) {}

  /** 缺少健康行表示从未失败，按零失败且未通知处理，防止首次成功被误判为恢复事件。 */
  public async get(regionalProductId: string): Promise<ProductHealthState> {
    const result = await this.database.query<ProductHealthRow>(
      `SELECT consecutive_failures AS "consecutiveFailures",
              failure_notified AS "failureNotified"
         FROM regional_product_health
        WHERE regional_product_id = $1`,
      [regionalProductId],
    );
    return result.rows[0] ?? { consecutiveFailures: 0, failureNotified: false };
  }

  /**
   * UPSERT 保存服务已计算状态；失败轮次的 null 成功时间通过 COALESCE 保留上一条成功证据，
   * 原生 BOOLEAN 参数保证通知标记不会接受 SQLite 式其他整数值。
   */
  public async save(regionalProductId: string, state: ProductHealthState, lastSuccessAt: string | null, updatedAt: string): Promise<void> {
    await this.database.query(
      `INSERT INTO regional_product_health (
         regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (regional_product_id) DO UPDATE SET
         consecutive_failures = EXCLUDED.consecutive_failures,
         last_success_at = COALESCE(EXCLUDED.last_success_at, regional_product_health.last_success_at),
         failure_notified = EXCLUDED.failure_notified,
         updated_at = EXCLUDED.updated_at`,
      [regionalProductId, state.consecutiveFailures, lastSuccessAt, state.failureNotified, updatedAt],
    );
  }
}
