import {
  buildDashboardOverview,
  type DashboardAllRegionHistoricalLow,
  type DashboardOverview,
  type DashboardPrice,
  type DashboardRegion,
  type DashboardSubscription,
} from "../../services/dashboard-service";
import type { PriceSource } from "../../shared/domain";
import type { DashboardReader } from "../ports";
import { SettingsRepository } from "../settings-repository";

/**
 * D1 的订阅聚合行仍使用 SQLite INTEGER 表示布尔值，并用 GROUP_CONCAT 传输已选地区商品 ID。
 * 这些数据库表示只允许停留在过渡适配器内，服务和公开 DTO 必须分别得到 boolean 与 string[]。
 */
interface DashboardSubscriptionRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: number;
  regionalProductIds: string | null;
}

/**
 * 每个已监控地区同时读取最新价、本币历史最低价和连续失败数。
 * LEFT JOIN 允许从未采集的商品返回空快照列，转换时不得把缺失金额、来源或时间伪造成零值价格。
 */
interface DashboardRegionRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  currency: string;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: PriceSource | null;
  currentCapturedAt: string | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: PriceSource | null;
  lowCapturedAt: string | null;
  consecutiveFailures: number | null;
}

/**
 * 跨区历史最低价行只可能来自 cny_fen 非空的快照，因此人民币分在该 DTO 中保持非空。
 * D1 的 TEXT 时间按既有 UTC ISO 存储契约原样传给业务 DTO，避免过渡适配器改变并列价格的历史结果。
 */
interface DashboardAllRegionLowRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number;
  source: PriceSource;
  capturedAt: string;
}

/**
 * 迁移期间的 D1 仪表盘适配器复刻原 DashboardService 的查询与行转换，再交给共享聚合函数计算统计和日报时间。
 * 查询仅覆盖设置、订阅、游戏、地区商品、价格与健康状态，不读取认证、会话或 Telegram 配置，维持概览接口的最小暴露边界。
 */
export class DashboardRepository implements DashboardReader {
  public constructor(private readonly database: D1Database) {}

  /**
   * 按原有创建顺序读取全部订阅及已选择地区；`now` 是服务传入的 UTC ISO 时间，只参与共享日报计算。
   * 三组价格查询保留原先所有并列排序规则，避免迁移过渡期因数据库适配层重排而让当前价或历史最低价跳动。
   */
  public async getOverview(now: string): Promise<DashboardOverview> {
    const [subscriptionResult, regionResult, allRegionLowResult, settings] = await Promise.all([
      this.database
        .prepare(
          `SELECT subscriptions.id AS subscriptionId, subscriptions.game_id AS gameId,
                  games.name_zh AS nameZh, games.name_en AS nameEn, subscriptions.enabled AS enabled,
                  GROUP_CONCAT(subscription_regions.regional_product_id) AS regionalProductIds
           FROM subscriptions
           INNER JOIN games ON games.id = subscriptions.game_id
           LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
           GROUP BY subscriptions.id
           ORDER BY subscriptions.created_at ASC`,
        )
        .all<DashboardSubscriptionRow>(),
      // 最新价在相同采集时间取最大自增 ID，本币最低价则依次取最早时间和最小 ID，确保结果决定性且与旧服务一致。
      this.database
        .prepare(
          `SELECT subscription_regions.subscription_id AS subscriptionId, products.id AS regionalProductId,
                  products.region_code AS regionCode, products.currency AS currency,
                  latest.amount_minor AS currentAmountMinor, latest.cny_fen AS currentCnyFen,
                  latest.source AS currentSource, latest.captured_at AS currentCapturedAt,
                  lowest.amount_minor AS lowAmountMinor, lowest.cny_fen AS lowCnyFen,
                  lowest.source AS lowSource, lowest.captured_at AS lowCapturedAt,
                  health.consecutive_failures AS consecutiveFailures
           FROM subscription_regions
           INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
           LEFT JOIN price_snapshots AS latest ON latest.id = (
             SELECT id FROM price_snapshots WHERE regional_product_id = products.id ORDER BY captured_at DESC, id DESC LIMIT 1
           )
           LEFT JOIN price_snapshots AS lowest ON lowest.id = (
             SELECT id FROM price_snapshots WHERE regional_product_id = products.id ORDER BY amount_minor ASC, captured_at ASC, id ASC LIMIT 1
           )
           LEFT JOIN regional_product_health AS health ON health.regional_product_id = products.id
           ORDER BY subscription_regions.subscription_id ASC, products.created_at ASC, products.id ASC`,
        )
        .all<DashboardRegionRow>(),
      // 跨区只能比较已换算的人民币分；相同人民币成本依次取最早快照和最小 ID，保持历史最低卡片稳定。
      this.database
        .prepare(
          `WITH ranked_lows AS (
             SELECT subscription_regions.subscription_id AS subscriptionId,
                    snapshots.regional_product_id AS regionalProductId,
                    products.region_code AS regionCode, snapshots.amount_minor AS amountMinor,
                    snapshots.currency AS currency, snapshots.cny_fen AS cnyFen,
                    snapshots.source AS source, snapshots.captured_at AS capturedAt,
                    ROW_NUMBER() OVER (
                      PARTITION BY subscription_regions.subscription_id
                      ORDER BY snapshots.cny_fen ASC, snapshots.captured_at ASC, snapshots.id ASC
                    ) AS priceRank
             FROM subscription_regions
             INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
             INNER JOIN price_snapshots AS snapshots ON snapshots.regional_product_id = products.id
             WHERE snapshots.cny_fen IS NOT NULL
           )
           SELECT subscriptionId, regionalProductId, regionCode, amountMinor, currency, cnyFen, source, capturedAt
           FROM ranked_lows
           WHERE priceRank = 1`,
        )
        .all<DashboardAllRegionLowRow>(),
      // 继续复用根目录的既有 D1 设置仓储；它只显式读取公开字段，并负责恢复已验证的管理员时区与日报分钟。
      new SettingsRepository(this.database).get(),
    ]);

    const regionsBySubscription = new Map<string, DashboardRegion[]>();
    for (const row of regionResult.results) {
      const current = toPrice(row.currentAmountMinor, row.currentCnyFen, row.currentSource, row.currentCapturedAt);
      const regions = regionsBySubscription.get(row.subscriptionId) ?? [];
      regions.push({
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        currency: row.currency,
        current,
        historicalLow: toPrice(row.lowAmountMinor, row.lowCnyFen, row.lowSource, row.lowCapturedAt),
        // 健康表缺行表示从未失败；必须同时已有旧价且连续失败，才可标记 stale，首次采集等待不能被误报为来源故障。
        isStale: current !== null && (row.consecutiveFailures ?? 0) > 0,
      });
      regionsBySubscription.set(row.subscriptionId, regions);
    }

    const allRegionLows = new Map<string, DashboardAllRegionHistoricalLow>();
    for (const row of allRegionLowResult.results) {
      allRegionLows.set(row.subscriptionId, {
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        amountMinor: row.amountMinor,
        currency: row.currency,
        cnyFen: row.cnyFen,
        source: row.source,
        capturedAt: row.capturedAt,
      });
    }

    const subscriptions: DashboardSubscription[] = subscriptionResult.results.map((row) => ({
      subscriptionId: row.subscriptionId,
      gameId: row.gameId,
      nameZh: row.nameZh,
      nameEn: row.nameEn,
      // D1 CHECK 约束把布尔值保存为 0/1；仅 1 表示启用，异常整数不会被宽松真值判断放入监控统计。
      enabled: row.enabled === 1,
      // LEFT JOIN 无地区时 GROUP_CONCAT 返回 null；其他情况保持 SQLite 原始拼接顺序，与旧仪表盘地区 ID 列表兼容。
      regionalProductIds: row.regionalProductIds?.split(",") ?? [],
      allRegionHistoricalLow: allRegionLows.get(row.subscriptionId) ?? null,
      regions: regionsBySubscription.get(row.subscriptionId) ?? [],
    }));

    return buildDashboardOverview(subscriptions, settings, now);
  }
}

/**
 * 将 D1 LEFT JOIN 行转换成完整价格快照；金额、来源或 TEXT 时间任一缺失都返回 null，避免生成无法审计来源的半截数据。
 * cnyFen 允许为空，因为单地区本币价格仍然有效，只是不能参与跨地区人民币历史最低价比较。
 */
function toPrice(
  amountMinor: number | null,
  cnyFen: number | null,
  source: PriceSource | null,
  capturedAt: string | null,
): DashboardPrice | null {
  if (amountMinor === null || source === null || capturedAt === null) return null;
  return { amountMinor, cnyFen, source, capturedAt };
}
