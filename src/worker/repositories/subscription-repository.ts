import type { SubscriptionInput, SubscriptionRecord } from "../../shared/domain";

/** 联表聚合后的 D1 行模型；GROUP_CONCAT 为空时表示订阅尚未关联任何已验证地区商品。 */
interface SubscriptionRow {
  id: string;
  gameId: string;
  enabled: number;
  createdAt: string;
  regionalProductIds: string | null;
}

/**
 * 订阅及其地区商品关联的仓储。订阅与价格历史分离，关闭订阅只更新 enabled，
 * 后续功能不得通过删除订阅清掉用户已经积累的历史价格。
 */
export class SubscriptionRepository {
  public constructor(private readonly database: D1Database) {}

  /**
   * 确认所有地区商品同时属于指定游戏且仍启用。关系表的外键只能保证商品存在，
   * 无法阻止跨游戏关联；用计数与已去重输入长度比较可在写订阅前阻断这种数据污染。
   */
  public async hasEnabledProductsForGame(gameId: string, regionalProductIds: string[]): Promise<boolean> {
    const placeholders = regionalProductIds.map(() => "?").join(", ");
    const row = await this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM regional_products
         WHERE game_id = ? AND enabled = 1 AND id IN (${placeholders})`,
      )
      .bind(gameId, ...regionalProductIds)
      .first<{ count: number }>();
    return row?.count === regionalProductIds.length;
  }

  public async create(input: SubscriptionInput): Promise<void> {
    // 先创建主订阅再写关系表，保证每个地区商品都可追溯到同一个用户确认的订阅配置。
    await this.database
      .prepare(
        `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .bind(input.id, input.gameId, input.createdAt, input.createdAt)
      .run();

    // 批量写入减少 Worker 与 D1 的往返；外键会拒绝不存在的地区商品，避免形成无效监控项。
    await this.database.batch(
      input.regionalProductIds.map((regionalProductId) =>
        this.database
          .prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
          .bind(input.id, regionalProductId),
      ),
    );
  }

  /**
   * 软停用或重新启用只更新订阅状态与审计时间，不触碰关系表和价格快照。
   * 这样“取消订阅”可立即停止任务，同时允许管理员未来恢复原有的地区组合和历史最低价。
   */
  public async setEnabled(id: string, enabled: boolean, updatedAt: string): Promise<boolean> {
    const result = await this.database
      .prepare("UPDATE subscriptions SET enabled = ?, updated_at = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, updatedAt, id)
      .run();
    return result.meta.changes === 1;
  }

  /** 替换目标价配置并把所有地区状态重置为未命中，防止旧阈值的已通知状态抑制新阈值提醒。 */
  public async setTargets(id: string, globalTargetCnyFen: number | null, regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>, updatedAt: string): Promise<boolean> {
    const updated = await this.database.prepare("UPDATE subscriptions SET global_target_cny_fen = ?, updated_at = ? WHERE id = ?").bind(globalTargetCnyFen, updatedAt, id).run();
    if (updated.meta.changes !== 1) return false;
    await this.database.batch([
      this.database.prepare("DELETE FROM subscription_region_targets WHERE subscription_id = ?").bind(id),
      ...regionTargets.map((target) => this.database.prepare("INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES (?, ?, ?, 'unmet')").bind(id, target.regionCode, target.targetAmountMinor)),
    ]);
    return true;
  }

  public async findByGameId(gameId: string): Promise<SubscriptionRecord | null> {
    // 游戏在当前 MVP 只能有一个订阅，查询按 game_id 而不是展示名称，防止多语言标题造成重复匹配。
    const row = await this.database
      .prepare(
        `SELECT
          subscriptions.id AS id,
          subscriptions.game_id AS gameId,
          subscriptions.enabled AS enabled,
          subscriptions.created_at AS createdAt,
          GROUP_CONCAT(subscription_regions.regional_product_id) AS regionalProductIds
        FROM subscriptions
        LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
        WHERE subscriptions.game_id = ?
        GROUP BY subscriptions.id`,
      )
      .bind(gameId)
      .first<SubscriptionRow>();

    if (!row) return null;

    // GROUP_CONCAT 仅是读取优化；返回前还原为领域数组，业务层不依赖数据库聚合格式。
    return {
      id: row.id,
      gameId: row.gameId,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      regionalProductIds: row.regionalProductIds?.split(",") ?? [],
    };
  }
}
