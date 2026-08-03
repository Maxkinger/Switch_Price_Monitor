import { buildHistoryResult, type HistoryResult, type HistoryRow } from "../../services/history-service";
import type { HistoryReader } from "../ports";

/**
 * D1 的 `captured_at` 以 ISO 文本保存并直接返回字符串；这里刻意沿用服务 DTO，
 * 不把时间交给宿主时区解析，避免过渡期内历史曲线的序列化结果与原 Worker 行为不一致。
 * 金额继续使用整数最小货币单位，`cnyFen=null` 明确表示采集时没有可用汇率，不能改写为零。
 */
type HistoryDatabaseRow = HistoryRow;

/**
 * 过渡期 D1 历史读取适配器把 Worker 数据库语句限制在仓储层，并实现平台中立的 `HistoryReader`。
 * 订阅 ID 与地区代码都只通过占位符绑定，不能参与 SQL 结构；查询也只选择前端曲线需要的字段，
 * 防止内部快照主键、商品地址以及任何认证或通知配置越过读取边界。
 */
export class HistoryRepository implements HistoryReader {
  public constructor(private readonly database: D1Database) {}

  /**
   * 按订阅读取不可变价格快照，并可选地限制单一地区。
   * SQLite 需要分别绑定空值判断和地区相等比较，所以 `region` 保持旧实现的两次绑定；
   * 时间相同时再按快照主键升序，确保曲线点和导出前后的顺序稳定且可复现。
   */
  public async list(subscriptionId: string, region: string | null): Promise<HistoryResult> {
    const result = await this.database
      .prepare(
        `SELECT products.region_code AS regionCode, snapshots.amount_minor AS amountMinor, snapshots.currency AS currency,
                snapshots.cny_fen AS cnyFen, snapshots.source AS source, snapshots.captured_at AS capturedAt
         FROM price_snapshots AS snapshots
         INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
         INNER JOIN subscription_regions ON subscription_regions.regional_product_id = products.id
         WHERE subscription_regions.subscription_id = ? AND (? IS NULL OR products.region_code = ?)
         ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
      )
      .bind(subscriptionId, region, region)
      .all<HistoryDatabaseRow>();

    // D1 已返回数据库中原始的时间字符串；统一交给服务辅助函数构造稳定响应外壳，不做方言相关转换。
    return buildHistoryResult(result.results);
  }
}
