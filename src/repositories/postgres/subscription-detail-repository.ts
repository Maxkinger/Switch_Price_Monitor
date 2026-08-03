import type { SqlExecutor } from "../../server/database/types";
import type { SubscriptionDetail, SubscriptionDetailPriceSnapshot, SubscriptionDetailReader } from "../ports";

/** 订阅与游戏基础行使用原生 BOOLEAN；缺失订阅时仓储返回 null，不构造部分 DTO。 */
interface SubscriptionDetailRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  productType: string;
  enabled: boolean;
  globalTargetCnyFen: number | null;
}

/** 单区目标只返回展示与编辑所需字段，内部 target_state 不得泄漏到读取 DTO。 */
interface RegionTargetRow {
  regionCode: string;
  targetAmountMinor: number;
}

/** 地区详情行保留 LEFT JOIN 的可空列与驱动 Date，映射层据此区分未采集和采集后失败。 */
interface RegionDetailRow {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  monitored: boolean;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: string | null;
  currentCapturedAt: Date | string | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: string | null;
  lowCapturedAt: Date | string | null;
  consecutiveFailures: number | null;
}

/**
 * PostgreSQL 订阅详情读取仓储返回平台中立 DTO。
 * 地区范围以同一游戏全部已启用确认商品为准，使管理员能重新选择暂未监控地区，而不能注入任意商品 ID。
 */
export class SubscriptionDetailRepository implements SubscriptionDetailReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async find(subscriptionId: string): Promise<SubscriptionDetail | null> {
    const subscriptionResult = await this.database.query<SubscriptionDetailRow>(
      `SELECT subscriptions.id AS "subscriptionId",
              games.id AS "gameId",
              games.name_zh AS "nameZh",
              games.name_en AS "nameEn",
              games.product_type AS "productType",
              subscriptions.enabled AS enabled,
              subscriptions.global_target_cny_fen AS "globalTargetCnyFen"
         FROM subscriptions
         INNER JOIN games ON games.id = subscriptions.game_id
        WHERE subscriptions.id = $1`,
      [subscriptionId],
    );
    const subscription = subscriptionResult.rows[0];
    if (!subscription) return null;

    const [targetResult, regionResult] = await Promise.all([
      this.database.query<RegionTargetRow>(
        `SELECT region_code AS "regionCode",
                target_amount_minor AS "targetAmountMinor"
           FROM subscription_region_targets
          WHERE subscription_id = $1
          ORDER BY region_code ASC`,
        [subscriptionId],
      ),
      this.database.query<RegionDetailRow>(
        `SELECT products.id AS "regionalProductId",
                products.region_code AS "regionCode",
                products.currency AS currency,
                (subscription_regions.regional_product_id IS NOT NULL) AS monitored,
                latest.amount_minor AS "currentAmountMinor",
                latest.cny_fen AS "currentCnyFen",
                latest.source AS "currentSource",
                latest.captured_at AS "currentCapturedAt",
                lowest.amount_minor AS "lowAmountMinor",
                lowest.cny_fen AS "lowCnyFen",
                lowest.source AS "lowSource",
                lowest.captured_at AS "lowCapturedAt",
                health.consecutive_failures AS "consecutiveFailures"
           FROM regional_products AS products
           LEFT JOIN subscription_regions
             ON subscription_regions.regional_product_id = products.id
            AND subscription_regions.subscription_id = $1
           LEFT JOIN price_snapshots AS latest ON latest.id = (
             SELECT id
               FROM price_snapshots
              WHERE regional_product_id = products.id
              ORDER BY captured_at DESC, id DESC
              LIMIT 1
           )
           LEFT JOIN price_snapshots AS lowest ON lowest.id = (
             SELECT id
               FROM price_snapshots
              WHERE regional_product_id = products.id
              ORDER BY amount_minor ASC, captured_at ASC, id ASC
              LIMIT 1
           )
           LEFT JOIN regional_product_health AS health ON health.regional_product_id = products.id
          WHERE products.game_id = $2
            AND products.enabled IS TRUE
          ORDER BY (subscription_regions.regional_product_id IS NOT NULL) DESC,
                   products.created_at ASC,
                   products.id ASC`,
        [subscriptionId, subscription.gameId],
      ),
    ]);

    return {
      subscriptionId: subscription.subscriptionId,
      game: {
        id: subscription.gameId,
        nameZh: subscription.nameZh,
        nameEn: subscription.nameEn,
        productType: subscription.productType,
      },
      enabled: subscription.enabled,
      globalTargetCnyFen: subscription.globalTargetCnyFen,
      regionTargets: targetResult.rows.map((target) => ({ ...target })),
      regions: regionResult.rows.map((region) => {
        const current = toPriceSnapshot(region.currentAmountMinor, region.currentCnyFen, region.currentSource, region.currentCapturedAt);
        return {
          regionalProductId: region.regionalProductId,
          regionCode: region.regionCode,
          currency: region.currency,
          monitored: region.monitored,
          current,
          historicalLow: toPriceSnapshot(region.lowAmountMinor, region.lowCnyFen, region.lowSource, region.lowCapturedAt),
          // 只有存在可信旧价且其后出现连续失败才 stale；从未采集的可选地区继续显示等待首笔价格。
          isStale: current !== null && (region.consecutiveFailures ?? 0) > 0,
        };
      }),
    };
  }
}

/** LEFT JOIN 任一关键列缺失都表示没有完整快照；完整记录才规范化时间并返回展示对象。 */
function toPriceSnapshot(
  amountMinor: number | null,
  cnyFen: number | null,
  source: string | null,
  capturedAt: Date | string | null,
): SubscriptionDetailPriceSnapshot | null {
  if (amountMinor === null || source === null || capturedAt === null) return null;
  return { amountMinor, cnyFen, source, capturedAt: toIsoString(capturedAt) };
}

/** pg 的 TIMESTAMPTZ Date 必须以 UTC ISO 字符串离开仓储，避免宿主时区影响详情显示和排序复核。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("订阅详情价格时间无效。");
  return date.toISOString();
}
