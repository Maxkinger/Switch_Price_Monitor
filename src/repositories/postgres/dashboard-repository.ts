import type { SqlExecutor } from "../../server/database/types";
import type { PriceSource } from "../../shared/domain";
import type {
  DashboardAllRegionHistoricalLow,
  DashboardOverview,
  DashboardPrice,
  DashboardRegion,
  DashboardSubscription,
} from "../../services/dashboard-service";
import type { DashboardReader } from "../ports";
import { PostgresSettingsRepository } from "./settings-repository";

interface SubscriptionRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: boolean;
  regionalProductIds: string[];
}
interface RegionRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  currency: string;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: PriceSource | null;
  currentCapturedAt: Date | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: PriceSource | null;
  lowCapturedAt: Date | null;
  consecutiveFailures: number | null;
}
interface AllRegionLowRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number;
  source: PriceSource;
  capturedAt: Date;
}

/**
 * PostgreSQL 仪表盘聚合 reader。
 * 查询只联接设置、订阅、商品、价格和健康表，不触及认证、会话或 Telegram 列；
 * 原生 BOOLEAN、可空 LEFT JOIN、JSONB 设置与 TIMESTAMPTZ 都在仓储边界转换为既有 DTO。
 */
export class PostgresDashboardRepository implements DashboardReader {
  public constructor(private readonly database: SqlExecutor) {}

  public async getOverview(now = new Date()): Promise<DashboardOverview> {
    const [subscriptions, regions, allRegionLows, settings] = await Promise.all([
      this.database.query<SubscriptionRow>(
        `SELECT subscriptions.id AS "subscriptionId",
                subscriptions.game_id AS "gameId",
                games.name_zh AS "nameZh",
                games.name_en AS "nameEn",
                subscriptions.enabled,
                COALESCE(
                  ARRAY_AGG(subscription_regions.regional_product_id ORDER BY subscription_regions.regional_product_id)
                    FILTER (WHERE subscription_regions.regional_product_id IS NOT NULL),
                  ARRAY[]::text[]
                ) AS "regionalProductIds"
           FROM subscriptions
           INNER JOIN games ON games.id = subscriptions.game_id
           LEFT JOIN subscription_regions
             ON subscription_regions.subscription_id = subscriptions.id
          GROUP BY subscriptions.id, games.id
          ORDER BY subscriptions.created_at ASC, subscriptions.id ASC`,
      ),
      this.database.query<RegionRow>(
        `SELECT subscription_regions.subscription_id AS "subscriptionId",
                products.id AS "regionalProductId",
                products.region_code AS "regionCode",
                products.currency,
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
           INNER JOIN regional_products AS products
             ON products.id = subscription_regions.regional_product_id
           LEFT JOIN price_snapshots AS latest ON latest.id = (
             SELECT id FROM price_snapshots
              WHERE regional_product_id = products.id
              ORDER BY captured_at DESC, id DESC LIMIT 1
           )
           LEFT JOIN price_snapshots AS lowest ON lowest.id = (
             SELECT id FROM price_snapshots
              WHERE regional_product_id = products.id
              ORDER BY amount_minor ASC, captured_at ASC, id ASC LIMIT 1
           )
           LEFT JOIN regional_product_health AS health
             ON health.regional_product_id = products.id
          ORDER BY subscription_regions.subscription_id ASC, products.created_at ASC, products.id ASC`,
      ),
      this.database.query<AllRegionLowRow>(
        `WITH ranked_lows AS (
           SELECT subscription_regions.subscription_id AS "subscriptionId",
                  snapshots.regional_product_id AS "regionalProductId",
                  products.region_code AS "regionCode",
                  snapshots.amount_minor AS "amountMinor",
                  snapshots.currency,
                  snapshots.cny_fen AS "cnyFen",
                  snapshots.source,
                  snapshots.captured_at AS "capturedAt",
                  ROW_NUMBER() OVER (
                    PARTITION BY subscription_regions.subscription_id
                    ORDER BY snapshots.cny_fen ASC, snapshots.captured_at ASC, snapshots.id ASC
                  ) AS "priceRank"
             FROM subscription_regions
             INNER JOIN regional_products AS products
               ON products.id = subscription_regions.regional_product_id
             INNER JOIN price_snapshots AS snapshots
               ON snapshots.regional_product_id = products.id
            WHERE snapshots.cny_fen IS NOT NULL
         )
         SELECT "subscriptionId", "regionalProductId", "regionCode",
                "amountMinor", currency, "cnyFen", source, "capturedAt"
           FROM ranked_lows
          WHERE "priceRank" = 1`,
      ),
      new PostgresSettingsRepository(this.database).get(),
    ]);

    const regionsBySubscription = new Map<string, DashboardRegion[]>();
    for (const row of regions.rows) {
      const values = regionsBySubscription.get(row.subscriptionId) ?? [];
      const current = toPrice(row.currentAmountMinor, row.currentCnyFen, row.currentSource, row.currentCapturedAt);
      values.push({
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        currency: row.currency,
        current,
        historicalLow: toPrice(row.lowAmountMinor, row.lowCnyFen, row.lowSource, row.lowCapturedAt),
        isStale: current !== null && (row.consecutiveFailures ?? 0) > 0,
      });
      regionsBySubscription.set(row.subscriptionId, values);
    }

    const lows = new Map<string, DashboardAllRegionHistoricalLow>();
    for (const row of allRegionLows.rows) {
      lows.set(row.subscriptionId, { ...row, capturedAt: row.capturedAt.toISOString() });
    }
    const dashboardSubscriptions = subscriptions.rows.map((row): DashboardSubscription => ({
      ...row,
      allRegionHistoricalLow: lows.get(row.subscriptionId) ?? null,
      regions: regionsBySubscription.get(row.subscriptionId) ?? [],
    }));
    const monitored = dashboardSubscriptions.filter((subscription) => subscription.enabled);
    const prices = monitored.flatMap((subscription) =>
      subscription.regions.map((region) => region.current).filter((price): price is DashboardPrice => price !== null),
    );
    const lastCapturedAt = prices.reduce<string | null>(
      (latest, price) => latest === null || price.capturedAt > latest ? price.capturedAt : latest,
      null,
    );
    return {
      stats: {
        monitoredSubscriptionCount: monitored.length,
        availableRegionPriceCount: prices.length,
        lastCapturedAt,
        timezone: settings?.timezone ?? null,
        nextDailyReportAt: settings ? nextDailyReportAt(now, settings.timezone, settings.dailyReportTime) : null,
      },
      subscriptions: dashboardSubscriptions,
    };
  }
}

/** LEFT JOIN 只有完整金额、来源和时间才构成价格；空值不能被误格式化为零。 */
function toPrice(
  amountMinor: number | null,
  cnyFen: number | null,
  source: PriceSource | null,
  capturedAt: Date | null,
): DashboardPrice | null {
  if (amountMinor === null || source === null || capturedAt === null) return null;
  return { amountMinor, cnyFen, source, capturedAt: capturedAt.toISOString() };
}

/** 逐分钟交给 Intl 处理管理员时区与夏令时，26 小时覆盖一次完整本地日及 DST 跳变。 */
function nextDailyReportAt(now: Date, timezone: string, dailyReportTime: string): string | null {
  const first = new Date(now.getTime());
  first.setUTCSeconds(0, 0);
  for (let offsetMinutes = 1; offsetMinutes <= 26 * 60; offsetMinutes += 1) {
    const candidate = new Date(first.getTime() + offsetMinutes * 60_000);
    if (formatHourMinute(candidate, timezone) === dailyReportTime) return candidate.toISOString();
  }
  return null;
}

/** 固定产生 HH:mm，避免宿主区域把 09:00 缩写为 9:00。 */
function formatHourMinute(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.hour}:${fields.minute}`;
}
