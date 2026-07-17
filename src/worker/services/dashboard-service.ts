/** 仪表盘订阅概览的 D1 行模型；地区商品 ID 仅用于后续关联当前价格与历史最低价。 */
interface DashboardRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: number;
  regionalProductIds: string | null;
}

/** 地区价格行同时携带最新与最低快照；空字段表示已配置地区尚未成功采集，不能伪造为零价格。 */
interface DashboardRegionRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  currency: string;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: string | null;
  currentCapturedAt: string | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: string | null;
  lowCapturedAt: string | null;
}

/**
 * 跨区历史最低价只接受已完成人民币换算的快照。人民币分缺失通常表示汇率采集失败，
 * 若参与排序会把不可比较的数据误显示为最低购买成本，因此查询层必须先排除。
 */
interface DashboardAllRegionLowRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number;
  source: string;
  capturedAt: string;
}

/**
 * 仪表盘服务提供稳定的订阅概览。刷新状态将在后续查询加入同一响应，
 * 让前端即使在首次初始化且尚未添加游戏时也始终能以 subscriptions 数组安全渲染。
 */
export class DashboardService {
  public constructor(private readonly database: D1Database) {}

  /**
   * 按创建时间读取全部订阅及其已确认地区商品。使用 LEFT JOIN 保留异常迁移状态下没有地区项的订阅，
   * 让管理员能看见并修复配置，而不是在仪表盘中被静默隐藏。
   */
  public async getOverview(): Promise<{ subscriptions: Array<{ subscriptionId: string; gameId: string; nameZh: string; nameEn: string; enabled: boolean; regionalProductIds: string[]; regions: Array<Record<string, unknown>> }> }> {
    const result = await this.database
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
      .all<DashboardRow>();
    // 为每个地区商品以相关子查询选取最新与最低快照；同一时间的并列记录用 id 打破平局，保证页面结果稳定。
    const regionResult = await this.database.prepare(
      `SELECT subscription_regions.subscription_id AS subscriptionId, products.id AS regionalProductId,
              products.region_code AS regionCode, products.currency AS currency,
              latest.amount_minor AS currentAmountMinor, latest.cny_fen AS currentCnyFen, latest.source AS currentSource, latest.captured_at AS currentCapturedAt,
              lowest.amount_minor AS lowAmountMinor, lowest.cny_fen AS lowCnyFen, lowest.source AS lowSource, lowest.captured_at AS lowCapturedAt
       FROM subscription_regions
       INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
       LEFT JOIN price_snapshots AS latest ON latest.id = (
         SELECT id FROM price_snapshots WHERE regional_product_id = products.id ORDER BY captured_at DESC, id DESC LIMIT 1
       )
       LEFT JOIN price_snapshots AS lowest ON lowest.id = (
         SELECT id FROM price_snapshots WHERE regional_product_id = products.id ORDER BY amount_minor ASC, captured_at ASC, id ASC LIMIT 1
       )`,
    ).all<DashboardRegionRow>();
    // 用窗口函数在每个订阅内按人民币购买成本排序；同价时保留更早快照，最后按主键稳定消除并列，避免日报与页面在无价格变化时来回跳动。
    const allRegionLowResult = await this.database.prepare(
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
    ).all<DashboardAllRegionLowRow>();
    const regionsBySubscription = new Map<string, Array<Record<string, unknown>>>();
    for (const row of regionResult.results) {
      const regions = regionsBySubscription.get(row.subscriptionId) ?? [];
      regions.push({
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        currency: row.currency,
        current: row.currentCapturedAt === null ? null : { amountMinor: row.currentAmountMinor, cnyFen: row.currentCnyFen, source: row.currentSource, capturedAt: row.currentCapturedAt },
        historicalLow: row.lowCapturedAt === null ? null : { amountMinor: row.lowAmountMinor, cnyFen: row.lowCnyFen, source: row.lowSource, capturedAt: row.lowCapturedAt },
      });
      regionsBySubscription.set(row.subscriptionId, regions);
    }
    // 一个订阅最多只有一条跨区最低记录；未采集汇率的订阅显式保留 null，提示前端不要将本币最低价误当跨区最低价。
    const allRegionLowsBySubscription = new Map<string, Record<string, unknown>>();
    for (const row of allRegionLowResult.results) {
      allRegionLowsBySubscription.set(row.subscriptionId, {
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        amountMinor: row.amountMinor,
        currency: row.currency,
        cnyFen: row.cnyFen,
        source: row.source,
        capturedAt: row.capturedAt,
      });
    }
    return {
      subscriptions: result.results.map((row) => ({
        subscriptionId: row.subscriptionId,
        gameId: row.gameId,
        nameZh: row.nameZh,
        nameEn: row.nameEn,
        enabled: row.enabled === 1,
        regionalProductIds: row.regionalProductIds?.split(",") ?? [],
        allRegionHistoricalLow: allRegionLowsBySubscription.get(row.subscriptionId) ?? null,
        regions: regionsBySubscription.get(row.subscriptionId) ?? [],
      })),
    };
  }
}
