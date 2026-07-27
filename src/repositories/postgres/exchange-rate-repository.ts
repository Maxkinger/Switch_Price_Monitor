import type { RateResult } from "../../providers/types";
import type { SqlExecutor } from "../../server/database/types";
import type { ExchangeRateReader } from "../ports";

/** PostgreSQL TIMESTAMPTZ 由 pg 解码为 Date，别名必须与应用字段完全一致。 */
interface ExchangeRateRow {
  currency: string;
  cnyRate: number;
  source: string;
  capturedAt: Date;
}

/**
 * PostgreSQL 最近汇率读取仓储。
 * 币种始终使用参数绑定；相同捕获时刻以 BIGINT identity 降序固定顺序，
 * 但 identity 只参与数据库排序，绝不转换成可能丢失精度的 JavaScript number。
 */
export class PostgresExchangeRateRepository implements ExchangeRateReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async latestFor(currency: string): Promise<RateResult | null> {
    const result = await this.database.query<ExchangeRateRow>(
      `SELECT currency,
              cny_rate AS "cnyRate",
              source,
              captured_at AS "capturedAt"
         FROM exchange_rates
        WHERE currency = $1
        ORDER BY captured_at DESC, id DESC
        LIMIT 1`,
      [currency],
    );
    const row = result.rows[0];
    return row
      ? { ...row, capturedAt: row.capturedAt.toISOString() }
      : null;
  }
}
