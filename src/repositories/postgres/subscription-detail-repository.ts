import type { SqlExecutor } from "../../server/database/types";
import type {
  SubscriptionDetail,
  SubscriptionDetailReader,
  SubscriptionDetailPriceSnapshot,
} from "../ports";

interface SubscriptionRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  productType: string;
  enabled: boolean;
}
interface RegionRow {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  monitored: boolean;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: string | null;
  currentCapturedAt: Date | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: string | null;
  lowCapturedAt: Date | null;
  consecutiveFailures: number | null;
}

/**
 * PostgreSQL 订阅详情仓储。
 * 相关子查询用 captured_at 与 BIGINT identity 固定并列顺序；LEFT JOIN 空列保持 null，
 * 未监控但已确认的地区仍返回供管理员重新勾选，且不会暴露商品 URL 或认证资料。
 */
export class PostgresSubscriptionDetailRepository implements SubscriptionDetailReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async find(subscriptionId: string): Promise<SubscriptionDetail | null> {
    const subscriptionResult = await this.database.query<SubscriptionRow>(
      `SELECT subscriptions.id AS "subscriptionId",
              games.id AS "gameId",
              games.name_zh AS "nameZh",
              games.name_en AS "nameEn",
              games.product_type AS "productType",
              subscriptions.enabled
         FROM subscriptions
         INNER JOIN games ON games.id = subscriptions.game_id
        WHERE subscriptions.id = $1`,
      [subscriptionId],
    );
    const subscription = subscriptionResult.rows[0];
    if (!subscription) return null;

    const regions = await this.database.query<RegionRow>(
        `SELECT products.id AS "regionalProductId",
                products.region_code AS "regionCode",
                products.currency,
                subscription_regions.regional_product_id IS NOT NULL AS monitored,
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
           LEFT JOIN regional_product_health AS health
             ON health.regional_product_id = products.id
          WHERE products.game_id = $2
            AND products.enabled IS TRUE
          ORDER BY monitored DESC, products.created_at ASC, products.id ASC`,
        [subscriptionId, subscription.gameId],
    );

    return {
      subscriptionId: subscription.subscriptionId,
      game: {
        id: subscription.gameId,
        nameZh: subscription.nameZh,
        nameEn: subscription.nameEn,
        productType: subscription.productType,
      },
      enabled: subscription.enabled,
      regions: regions.rows.map((region) => ({
        regionalProductId: region.regionalProductId,
        regionCode: region.regionCode,
        currency: region.currency,
        monitored: region.monitored,
        current: toSnapshot(region.currentAmountMinor, region.currentCnyFen, region.currentSource, region.currentCapturedAt),
        historicalLow: toSnapshot(region.lowAmountMinor, region.lowCnyFen, region.lowSource, region.lowCapturedAt),
        isStale: region.currentCapturedAt !== null && (region.consecutiveFailures ?? 0) > 0,
      })),
    };
  }
}

/** 四个 LEFT JOIN 列必须组成完整快照；缺少金额、来源或时间时统一返回 null，绝不伪造零价格。 */
function toSnapshot(
  amountMinor: number | null,
  cnyFen: number | null,
  source: string | null,
  capturedAt: Date | null,
): SubscriptionDetailPriceSnapshot | null {
  if (amountMinor === null || source === null || capturedAt === null) return null;
  return { amountMinor, cnyFen, source, capturedAt: capturedAt.toISOString() };
}
