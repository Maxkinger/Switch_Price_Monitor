import type { SubscriptionInput, SubscriptionRecord } from "../../shared/domain";

/** 联表聚合后的 D1 行模型；GROUP_CONCAT 为空时表示订阅尚未关联任何已验证地区商品。 */
interface SubscriptionRow {
  id: string;
  gameId: string;
  enabled: number;
  createdAt: string;
  regionalProductIds: string | null;
}

/** 硬删除前由订阅 ID 取得的最小归属信息；游戏 ID 只用于参数化关联清理，绝不从浏览器请求体读取。 */
interface SubscriptionDeletionTarget {
  id: string;
  gameId: string;
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

  /** 查询订阅的逻辑游戏，用于地区编辑前验证商品归属；不把订阅的其他内部字段暴露给路由。 */
  public async gameIdForSubscription(id: string): Promise<string | null> {
    const row = await this.database.prepare("SELECT game_id AS gameId FROM subscriptions WHERE id = ?").bind(id).first<{ gameId: string }>();
    return row?.gameId ?? null;
  }

  /** 替换地区关联而保留订阅、历史快照和目标价记录；新地区范围只影响后续采集和通知。 */
  public async replaceRegionalProducts(id: string, regionalProductIds: string[], updatedAt: string): Promise<void> {
    await this.database.batch([
      this.database.prepare("DELETE FROM subscription_regions WHERE subscription_id = ?").bind(id),
      ...regionalProductIds.map((productId) => this.database.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind(id, productId)),
      this.database.prepare("UPDATE subscriptions SET updated_at = ? WHERE id = ?").bind(updatedAt, id),
    ]);
  }

  /**
   * 永久删除一组订阅及其只属于这些订阅的游戏、地区商品和价格数据。
   * 先读全量目标再执行单个 D1 batch：任一 ID 不存在时完全不写入；批次执行中发生错误时 D1 会整体回滚，
   * 防止管理员一次多选删除后留下没有订阅却仍占用空间的快照、日志或通知事件。
   */
  public async deleteMany(subscriptionIds: string[]): Promise<boolean> {
    const subscriptionPlaceholders = placeholdersFor(subscriptionIds);
    const targets = await this.database
      .prepare(`SELECT id, game_id AS gameId FROM subscriptions WHERE id IN (${subscriptionPlaceholders})`)
      .bind(...subscriptionIds)
      .all<SubscriptionDeletionTarget>();

    // 结果必须和已由路由去重的输入一一对应；否则不能删除“仍存在的部分”，以保持批量操作原子语义。
    if (targets.results.length !== subscriptionIds.length) return false;

    const gameIds = targets.results.map((target) => target.gameId);
    const gamePlaceholders = placeholdersFor(gameIds);
    const regionalProductsForGames = `SELECT id FROM regional_products WHERE game_id IN (${gamePlaceholders})`;

    /**
     * `fetch_logs` 的外键原本是 SET NULL，适合常规地区商品淘汰却不符合管理员明确的硬删除；
     * 因此在删地区商品前显式清理日志。游戏一订阅的唯一约束使这些 gameIds 不会属于未选订阅，
     * 允许在同一批次中安全删除其所有地区商品与游戏，而 exchange_rates、设置和认证记录不在此范围内。
     */
    await this.database.batch([
      this.database.prepare(`DELETE FROM notification_events WHERE subscription_id IN (${subscriptionPlaceholders}) OR regional_product_id IN (${regionalProductsForGames})`).bind(...subscriptionIds, ...gameIds),
      this.database.prepare(`DELETE FROM subscription_region_targets WHERE subscription_id IN (${subscriptionPlaceholders})`).bind(...subscriptionIds),
      this.database.prepare(`DELETE FROM subscription_regions WHERE subscription_id IN (${subscriptionPlaceholders})`).bind(...subscriptionIds),
      this.database.prepare(`DELETE FROM price_snapshots WHERE regional_product_id IN (${regionalProductsForGames})`).bind(...gameIds),
      this.database.prepare(`DELETE FROM fetch_logs WHERE regional_product_id IN (${regionalProductsForGames})`).bind(...gameIds),
      this.database.prepare(`DELETE FROM regional_product_health WHERE regional_product_id IN (${regionalProductsForGames})`).bind(...gameIds),
      this.database.prepare(`DELETE FROM subscriptions WHERE id IN (${subscriptionPlaceholders})`).bind(...subscriptionIds),
      this.database.prepare(`DELETE FROM regional_products WHERE game_id IN (${gamePlaceholders})`).bind(...gameIds),
      this.database.prepare(`DELETE FROM games WHERE id IN (${gamePlaceholders})`).bind(...gameIds),
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

/**
 * 占位符数量只来自已经过路由非空、去重校验的内部数组，所有实际值仍以 bind 传入。
 * 该 helper 绝不拼接浏览器输入，避免订阅 ID 被解释为 SQL 片段；空数组表示调用方违反仓储契约，直接抛错而非生成 `IN ()`。
 */
function placeholdersFor(values: readonly string[]): string {
  if (values.length === 0) throw new Error("硬删除至少需要一个已验证订阅标识。");
  return values.map(() => "?").join(", ");
}
