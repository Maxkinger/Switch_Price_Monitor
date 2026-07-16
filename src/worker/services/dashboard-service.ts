/** 仪表盘订阅概览的 D1 行模型；地区商品 ID 仅用于后续关联当前价格与历史最低价。 */
interface DashboardRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: number;
  regionalProductIds: string | null;
}

/**
 * 仪表盘服务提供稳定的订阅概览。价格快照、历史最低价和刷新状态将在后续查询加入同一响应，
 * 让前端即使在首次初始化且尚未添加游戏时也始终能以 subscriptions 数组安全渲染。
 */
export class DashboardService {
  public constructor(private readonly database: D1Database) {}

  /**
   * 按创建时间读取全部订阅及其已确认地区商品。使用 LEFT JOIN 保留异常迁移状态下没有地区项的订阅，
   * 让管理员能看见并修复配置，而不是在仪表盘中被静默隐藏。
   */
  public async getOverview(): Promise<{ subscriptions: Array<{ subscriptionId: string; gameId: string; nameZh: string; nameEn: string; enabled: boolean; regionalProductIds: string[] }> }> {
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
    return {
      subscriptions: result.results.map((row) => ({
        subscriptionId: row.subscriptionId,
        gameId: row.gameId,
        nameZh: row.nameZh,
        nameEn: row.nameEn,
        enabled: row.enabled === 1,
        regionalProductIds: row.regionalProductIds?.split(",") ?? [],
      })),
    };
  }
}
