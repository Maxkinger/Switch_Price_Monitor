import type { HistoricalLow, PriceSnapshot } from "../../shared/domain";

/**
 * 价格快照仓储只追加、不覆盖。当前价格、降价和历史最低价均从快照派生，
 * 以保留来源切换、汇率波动和促销结束后的审计证据。
 */
export class PriceRepository {
  public constructor(private readonly database: D1Database) {}

  public async append(snapshot: PriceSnapshot): Promise<void> {
    // 金额由调用方按最小货币单位规范化；仓储保持原样写入，避免浮点转换破坏跨币种比较。
    await this.database
      .prepare(
        `INSERT INTO price_snapshots (
          regional_product_id,
          amount_minor,
          currency,
          cny_fen,
          source,
          captured_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshot.regionalProductId,
        snapshot.amountMinor,
        snapshot.currency,
        snapshot.cnyFen,
        snapshot.source,
        snapshot.capturedAt,
      )
      .run();
  }

  public async countForRegionalProduct(regionalProductId: string): Promise<number> {
    // 计数用于测试和后续数据保留任务，不把完整快照加载到 Worker 内存中。
    const row = await this.database
      .prepare("SELECT COUNT(*) AS count FROM price_snapshots WHERE regional_product_id = ?")
      .bind(regionalProductId)
      .first<{ count: number }>();

    return row?.count ?? 0;
  }

  /**
   * 读取本地区最近一条官方成功快照，供新官方价格判断即时降价。
   * 第三方快照即使更新更晚也必须排除，避免来源切换或第三方促销触发“官方降价”通知。
   */
  public async latestOfficialFor(regionalProductId: string): Promise<{ amountMinor: number; source: "official" } | null> {
    return this.database
      .prepare(
        `SELECT amount_minor AS amountMinor, source
         FROM price_snapshots
         WHERE regional_product_id = ? AND source = 'official'
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`,
      )
      .bind(regionalProductId)
      .first<{ amountMinor: number; source: "official" }>();
  }

  public async lowestForRegionalProduct(regionalProductId: string): Promise<HistoricalLow | null> {
    // 同价时取最早捕获记录，确保历史最低价日期稳定；关联地区表以支持日报直接显示地区名称。
    return this.database
      .prepare(
        `SELECT
          snapshots.regional_product_id AS regionalProductId,
          snapshots.amount_minor AS amountMinor,
          snapshots.currency AS currency,
          snapshots.cny_fen AS cnyFen,
          snapshots.source AS source,
          snapshots.captured_at AS capturedAt,
          products.region_code AS regionCode
        FROM price_snapshots AS snapshots
        INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
        WHERE snapshots.regional_product_id = ?
        ORDER BY snapshots.amount_minor ASC, snapshots.captured_at ASC
        LIMIT 1`,
      )
      .bind(regionalProductId)
      .first<HistoricalLow>();
  }
}
