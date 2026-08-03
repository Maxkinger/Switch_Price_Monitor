import {
  formatFetchLogsCsv,
  formatPricesCsv,
  formatSubscriptionsCsv,
  type FetchLogExportRow,
  type PriceExportRow,
  type SubscriptionExportRow,
} from "../../services/export-service";
import type { ExportReader } from "../ports";

/**
 * D1 价格导出行沿用数据库中的 ISO 文本时间和整数金额；人民币分可空表示当次汇率缺失。
 * 该白名单不包含快照主键、外部响应或任何管理员凭据，避免备份文件扩大敏感数据范围。
 */
type PriceExportDatabaseRow = PriceExportRow;

/**
 * D1 用受约束的 INTEGER 保存订阅开关，旧 CSV 契约要求原样导出 `0` 或 `1`。
 * 这里禁止先转换为 JavaScript boolean，以免再次数字化时改变历史文件内容或引入方言差异。
 */
type SubscriptionExportDatabaseRow = SubscriptionExportRow;

/**
 * 地区商品被清理后，日志的地区代码可以为空；安全摘要消息也允许为空。
 * 捕获时间保持 D1 字符串，不使用 Node 的本地时区格式化，从而维持原 Worker 导出的逐字节行为。
 */
type FetchLogExportDatabaseRow = FetchLogExportRow;

/**
 * 过渡期 D1 导出适配器为三种用途维护独立、固定的查询白名单，并实现平台中立的 `ExportReader`。
 * 不接受表名、列名或任意 SQL 输入，因此即使未来新增密码、会话或 Telegram 字段，也无法被请求参数带入 CSV。
 */
export class ExportRepository implements ExportReader {
  public constructor(private readonly database: D1Database) {}

  /**
   * 导出全量价格历史。按捕获时间升序，并以快照主键打破同一时间戳的并列，
   * 使备份比较与后续恢复都具有确定顺序；CRLF、固定列序和字段转义由共享格式化函数统一保证。
   */
  public async pricesCsv(): Promise<string> {
    const result = await this.database
      .prepare(
        `SELECT products.region_code AS regionCode, snapshots.amount_minor AS amountMinor, snapshots.currency AS currency,
                snapshots.cny_fen AS cnyFen, snapshots.source AS source, snapshots.captured_at AS capturedAt
         FROM price_snapshots AS snapshots INNER JOIN regional_products AS products ON products.id = snapshots.regional_product_id
         ORDER BY snapshots.captured_at ASC, snapshots.id ASC`,
      )
      .all<PriceExportDatabaseRow>();

    // D1 的时间和值类型已经符合旧 CSV 契约，直接格式化可避免迁移适配器擅自规范化已有数据。
    return formatPricesCsv(result.results);
  }

  /**
   * 导出订阅及其已确认地区商品。LEFT JOIN 保留尚无地区关联的订阅，并把两个商品字段维持为 null，
   * 由共享格式化函数输出空单元格；`enabled` 保留 D1 的整数 `0/1`，不能映射成 `true/false` 文本。
   */
  public async subscriptionsCsv(): Promise<string> {
    const result = await this.database
      .prepare(
        `SELECT subscriptions.id AS subscriptionId, subscriptions.game_id AS gameId, subscriptions.enabled AS enabled,
                products.region_code AS regionCode, products.id AS regionalProductId
         FROM subscriptions LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
         LEFT JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
         ORDER BY subscriptions.created_at ASC, products.region_code ASC`,
      )
      .all<SubscriptionExportDatabaseRow>();

    return formatSubscriptionsCsv(result.results);
  }

  /**
   * 导出可诊断的安全日志摘要。显式列清单排除原始响应、Cookie、令牌与 Telegram 凭据，
   * 并按捕获时间和日志主键稳定排序；可空地区和消息由共享格式化函数安全转义为空单元格。
   */
  public async fetchLogsCsv(): Promise<string> {
    const result = await this.database
      .prepare(
        `SELECT products.region_code AS regionCode, logs.source AS source, logs.status AS status, logs.message AS message, logs.captured_at AS capturedAt
         FROM fetch_logs AS logs LEFT JOIN regional_products AS products ON products.id = logs.regional_product_id
         ORDER BY logs.captured_at ASC, logs.id ASC`,
      )
      .all<FetchLogExportDatabaseRow>();

    return formatFetchLogsCsv(result.results);
  }
}
