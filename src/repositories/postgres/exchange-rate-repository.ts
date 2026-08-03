import type { RateResult } from "../../providers/types";
import type { SqlExecutor } from "../../server/database/types";

/** PostgreSQL 汇率读取行保留驱动的 Date 可能性，返回服务 DTO 前统一为 UTC ISO 字符串。 */
interface ExchangeRateRow {
  currency: string;
  cnyRate: number;
  source: string;
  capturedAt: Date | string;
}

/**
 * PostgreSQL 汇率仓储保留每日成功来源事实并提供单币种最近值。
 * 过期回退标记仍由服务根据本轮外部请求结果决定，不能永久污染数据库中的原始来源记录。
 */
export class ExchangeRateRepository {
  public constructor(private readonly database: SqlExecutor) {}

  /** 同币种同捕获时刻依赖唯一键幂等追加；只忽略该明确冲突，其他约束错误必须暴露并停止任务。 */
  public async append(value: RateResult): Promise<void> {
    await this.database.query(
      `INSERT INTO exchange_rates (currency, cny_rate, source, captured_at, is_stale)
       VALUES ($1, $2, $3, $4, FALSE)
       ON CONFLICT (currency, captured_at) DO NOTHING`,
      [value.currency, value.cnyRate, value.source, value.capturedAt],
    );
  }

  /** 最近值按 UTC 捕获时间和 BIGINT 主键倒序稳定选择，避免并发写入时读取结果无确定性。 */
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
    if (!row) return null;
    return {
      currency: row.currency,
      cnyRate: row.cnyRate,
      source: row.source,
      capturedAt: toIsoString(row.capturedAt),
    };
  }
}

/** 驱动默认把 TIMESTAMPTZ 解码为 Date；显式转换保持 Worker 时代公开 DTO 的字符串契约。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("汇率捕获时间无效。");
  return date.toISOString();
}
