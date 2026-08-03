import type { RateResult } from "../providers/types";

/**
 * 汇率持久化边界只追加成功来源值并读取每种货币的最近记录。
 * 历史记录保留来源与时间，便于人民币历史低价在未来复核时说明采用了哪一日的中间价。
 */
export class ExchangeRateRepository {
  public constructor(private readonly database: D1Database) {}

  /** 成功来源结果以币种和来源捕获时间组成唯一记录；同一次任务重试不会写入重复行。 */
  public async append(value: RateResult): Promise<void> {
    await this.database
      .prepare(
        `INSERT OR IGNORE INTO exchange_rates (currency, cny_rate, source, captured_at, is_stale)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .bind(value.currency, value.cnyRate, value.source, value.capturedAt)
      .run();
  }

  /** 仅按捕获时间读取最近成功汇率；过期语义由服务层在本轮外部请求失败时决定，不能永久写成来源事实。 */
  public async latestFor(currency: string): Promise<RateResult | null> {
    return this.database
      .prepare(
        `SELECT currency, cny_rate AS cnyRate, source, captured_at AS capturedAt
         FROM exchange_rates
         WHERE currency = ?
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`,
      )
      .bind(currency)
      .first<RateResult>();
  }
}
