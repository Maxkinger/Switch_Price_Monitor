import type { SqlExecutor } from "../../server/database/types";
import type { ProductHealthState } from "../../services/price-rules";
import type { ProductHealthStore } from "../ports";

interface ProductHealthRow {
  consecutiveFailures: number;
  failureNotified: boolean;
}

/**
 * PostgreSQL 地区商品健康仓储。
 * 原生 BOOLEAN 直接映射为业务布尔值；失败轮次传入 null 时保留最近成功时间，
 * 且只保存失败计数与通知标记，不持久化外部响应、错误堆栈或 Telegram 凭据。
 */
export class PostgresProductHealthRepository implements ProductHealthStore {
  public constructor(private readonly database: SqlExecutor) {}

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

  public async save(
    regionalProductId: string,
    state: ProductHealthState,
    lastSuccessAt: string | null,
    updatedAt: string,
  ): Promise<void> {
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
