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
    return {
      subscriptions: result.results.map((row) => ({
        subscriptionId: row.subscriptionId,
        gameId: row.gameId,
        nameZh: row.nameZh,
        nameEn: row.nameEn,
        enabled: row.enabled === 1,
        regionalProductIds: row.regionalProductIds?.split(",") ?? [],
        regions: regionsBySubscription.get(row.subscriptionId) ?? [],
      })),
    };
  }
}
