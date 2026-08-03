import type { SqlExecutor } from "../../server/database/types";
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
import { SettingsRepository } from "./settings-repository";

/** 订阅聚合行使用稳定 TEXT[] 与原生 BOOLEAN，避免服务解析 GROUP_CONCAT 或 SQLite 0/1。 */
interface DashboardSubscriptionRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: boolean;
  regionalProductIds: string[];
}

/** 地区价格行保留全部可空 LEFT JOIN 列；仓储只在关键字段完整时构造价格 DTO。 */
interface DashboardRegionRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  currency: string;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: PriceSource | null;
  currentCapturedAt: Date | string | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: PriceSource | null;
  lowCapturedAt: Date | string | null;
  consecutiveFailures: number | null;
}

/** 跨区最低价只包含非空人民币值，TIMESTAMPTZ 在返回业务 DTO 前统一为 UTC ISO。 */
interface DashboardAllRegionLowRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number;
  source: PriceSource;
  capturedAt: Date | string;
}

/**
 * PostgreSQL 仪表盘读取仓储负责 SQL、行类型和 LEFT JOIN 转换，再调用服务层统计规则生成既有 DTO。
 * 查询只涉及设置、订阅、游戏、地区商品、价格和健康状态，不读取认证、会话或 Telegram 配置。
 */
export class DashboardRepository implements DashboardReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async getOverview(now: string): Promise<DashboardOverview> {
    const [subscriptionResult, regionResult, allRegionLowResult, settings] = await Promise.all([
      this.database.query<DashboardSubscriptionRow>(
        `SELECT subscriptions.id AS "subscriptionId",
                subscriptions.game_id AS "gameId",
                games.name_zh AS "nameZh",
                games.name_en AS "nameEn",
                subscriptions.enabled AS enabled,
                COALESCE(
                  ARRAY_AGG(subscription_regions.regional_product_id ORDER BY subscription_regions.regional_product_id)
                    FILTER (WHERE subscription_regions.regional_product_id IS NOT NULL),
                  ARRAY[]::TEXT[]
                ) AS "regionalProductIds"
           FROM subscriptions
           INNER JOIN games ON games.id = subscriptions.game_id
           LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
          GROUP BY subscriptions.id, subscriptions.game_id, games.name_zh, games.name_en,
                   subscriptions.enabled, subscriptions.created_at
          ORDER BY subscriptions.created_at ASC, subscriptions.id ASC`,
      ),
      // 每个地区独立选择最新价和本币最低价；相同捕获时间分别用 id DESC/ASC 保持决定性顺序。
      this.database.query<DashboardRegionRow>(
        `SELECT subscription_regions.subscription_id AS "subscriptionId",
                products.id AS "regionalProductId",
                products.region_code AS "regionCode",
                products.currency AS currency,
                latest.amount_minor AS "currentAmountMinor",
                latest.cny_fen AS "currentCnyFen",
                latest.source AS "currentSource",
                latest.captured_at AS "currentCapturedAt",
                lowest.amount_minor AS "lowAmountMinor",
                lowest.cny_fen AS "lowCnyFen",
                lowest.source AS "lowSource",
                lowest.captured_at AS "lowCapturedAt",
                health.consecutive_failures AS "consecutiveFailures"
           FROM subscription_regions
           INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
           LEFT JOIN price_snapshots AS latest ON latest.id = (
             SELECT id FROM price_snapshots
              WHERE regional_product_id = products.id
              ORDER BY captured_at DESC, id DESC
              LIMIT 1
           )
           LEFT JOIN price_snapshots AS lowest ON lowest.id = (
             SELECT id FROM price_snapshots
              WHERE regional_product_id = products.id
              ORDER BY amount_minor ASC, captured_at ASC, id ASC
              LIMIT 1
           )
           LEFT JOIN regional_product_health AS health ON health.regional_product_id = products.id
          ORDER BY subscription_regions.subscription_id ASC, products.created_at ASC, products.id ASC`,
      ),
      // 只有已换算人民币的快照可跨区比较；同人民币值取最早时间与最早 identity，防止历史卡片跳动。
      this.database.query<DashboardAllRegionLowRow>(
        `WITH ranked_lows AS (
           SELECT subscription_regions.subscription_id AS "subscriptionId",
                  snapshots.regional_product_id AS "regionalProductId",
                  products.region_code AS "regionCode",
                  snapshots.amount_minor AS "amountMinor",
                  snapshots.currency AS currency,
                  snapshots.cny_fen AS "cnyFen",
                  snapshots.source AS source,
                  snapshots.captured_at AS "capturedAt",
                  ROW_NUMBER() OVER (
                    PARTITION BY subscription_regions.subscription_id
                    ORDER BY snapshots.cny_fen ASC, snapshots.captured_at ASC, snapshots.id ASC
                  ) AS "priceRank"
             FROM subscription_regions
             INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
             INNER JOIN price_snapshots AS snapshots ON snapshots.regional_product_id = products.id
            WHERE snapshots.cny_fen IS NOT NULL
         )
         SELECT "subscriptionId", "regionalProductId", "regionCode", "amountMinor", currency,
                "cnyFen", source, "capturedAt"
           FROM ranked_lows
          WHERE "priceRank" = 1`,
      ),
      new SettingsRepository(this.database).get(),
    ]);

    const regionsBySubscription = new Map<string, DashboardRegion[]>();
    for (const row of regionResult.rows) {
      const current = toPrice(row.currentAmountMinor, row.currentCnyFen, row.currentSource, row.currentCapturedAt);
      const regions = regionsBySubscription.get(row.subscriptionId) ?? [];
      regions.push({
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        currency: row.currency,
        current,
        historicalLow: toPrice(row.lowAmountMinor, row.lowCnyFen, row.lowSource, row.lowCapturedAt),
        // 健康表缺行表示从未失败；只有存在旧价且连续失败时才标 stale，避免把首笔采集等待误报为故障。
        isStale: current !== null && (row.consecutiveFailures ?? 0) > 0,
      });
      regionsBySubscription.set(row.subscriptionId, regions);
    }

    const allRegionLows = new Map<string, DashboardAllRegionHistoricalLow>();
    for (const row of allRegionLowResult.rows) {
      allRegionLows.set(row.subscriptionId, {
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        amountMinor: row.amountMinor,
        currency: row.currency,
        cnyFen: row.cnyFen,
        source: row.source,
        capturedAt: toIsoString(row.capturedAt),
      });
    }

    const subscriptions: DashboardSubscription[] = subscriptionResult.rows.map((row) => ({
      subscriptionId: row.subscriptionId,
      gameId: row.gameId,
      nameZh: row.nameZh,
      nameEn: row.nameEn,
      enabled: row.enabled,
      regionalProductIds: row.regionalProductIds,
      allRegionHistoricalLow: allRegionLows.get(row.subscriptionId) ?? null,
      regions: regionsBySubscription.get(row.subscriptionId) ?? [],
    }));

    return buildDashboardOverview(subscriptions, settings, now);
  }
}

/** LEFT JOIN 的关键列不完整即没有可解释快照；完整记录统一把 TIMESTAMPTZ 规范化为 ISO。 */
function toPrice(
  amountMinor: number | null,
  cnyFen: number | null,
  source: PriceSource | null,
  capturedAt: Date | string | null,
): DashboardPrice | null {
  if (amountMinor === null || source === null || capturedAt === null) return null;
  return { amountMinor, cnyFen, source, capturedAt: toIsoString(capturedAt) };
}

/** pg 默认 Date 与测试字符串都转换为 UTC ISO；无效值明确失败，不能把宿主本地日期带入统计。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("仪表盘价格时间无效。");
  return date.toISOString();
}
