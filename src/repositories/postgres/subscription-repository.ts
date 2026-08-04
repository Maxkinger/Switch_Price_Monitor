import type { AppDatabase, SqlExecutor } from "../../server/database/types";
import type { SubscriptionInput, SubscriptionRecord } from "../../shared/domain";
import type {
  AtomicRegionalProductReplacementResult,
  AtomicSubscriptionCreationResult,
  SubscriptionStore,
} from "../ports";

/** PostgreSQL ARRAY_AGG、BOOLEAN 与 TIMESTAMPTZ 解码后的内部行，返回前转换为既有订阅领域模型。 */
interface SubscriptionRow {
  id: string;
  gameId: string;
  enabled: boolean;
  createdAt: Date | string;
  regionalProductIds: string[];
}

/** 普通订阅事务按 game_id 返回稳定主键，重复提交不能覆盖管理员已经选择的地区范围。 */
interface ExistingSubscriptionIdRow {
  id: string;
}

/** 永久删除在事务内锁定的最小所有权信息；gameId 只来自数据库，绝不能由浏览器删除载荷提供。 */
interface SubscriptionDeletionTargetRow {
  id: string;
  gameId: string;
}

/** 地区替换与存在性查询只需稳定逻辑游戏 ID，不读取价格、标题或任何通知事实。 */
interface SubscriptionGameRow {
  gameId: string;
}

/**
 * PostgreSQL 订阅读写仓储。
 * 普通创建、目标价替换、地区替换和永久删除都在仓储内建立短事务，服务不会取得 executor，也不能把外部网络工作包进数据库连接。
 */
export class SubscriptionRepository implements SubscriptionStore {
  public constructor(private readonly database: AppDatabase) {}

  /**
   * 同一事务锁定游戏主档后执行查重、商品归属验证、订阅插入和关系插入。
   * 游戏行锁让两个进程对同一 gameId 串行：失败者读取获胜订阅并返回 existing，绝不会用第二次提交覆盖既有地区配置。
   */
  public async createOrOpenAtomically(input: SubscriptionInput): Promise<AtomicSubscriptionCreationResult> {
    return this.database.transaction(async (transaction) => {
      const game = await transaction.query<{ id: string }>(
        "SELECT id FROM games WHERE id = $1 FOR UPDATE",
        [input.gameId],
      );
      if (game.rowCount !== 1) return { status: "product-mismatch" };

      const existing = await findSubscriptionIdByGame(transaction, input.gameId);
      if (existing) return { status: "existing", subscriptionId: existing };
      if (!(await hasEnabledProductsForGame(transaction, input.gameId, input.regionalProductIds))) {
        return { status: "product-mismatch" };
      }

      await insertSubscription(transaction, input);
      await insertSubscriptionRegions(transaction, input.id, input.regionalProductIds);
      return { status: "created", subscriptionId: input.id };
    });
  }

  /** 独立归属检查保留端口兼容；写路径应优先使用把检查与写入收进同一事务的原子方法。 */
  public async hasEnabledProductsForGame(gameId: string, regionalProductIds: string[]): Promise<boolean> {
    return hasEnabledProductsForGame(this.database, gameId, regionalProductIds);
  }

  /** 主订阅与全部关系使用同一个 transaction executor；任一外键失败都会撤销主记录。 */
  public async create(input: SubscriptionInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await insertSubscription(transaction, input);
      await insertSubscriptionRegions(transaction, input.id, input.regionalProductIds);
    });
  }

  /** 软停用只改变后续采集与通知资格，地区关系、目标价和历史快照必须全部保留。 */
  public async setEnabled(id: string, enabled: boolean, updatedAt: string): Promise<boolean> {
    const result = await this.database.query(
      "UPDATE subscriptions SET enabled = $1, updated_at = $2 WHERE id = $3",
      [enabled, updatedAt, id],
    );
    return result.rowCount === 1;
  }

  /**
   * 全局目标、旧单区目标清理和新目标插入共享事务。
   * 若订阅不存在，第一条 UPDATE 零行后立即返回且不删除任何目标；后续任一 INSERT 失败会恢复旧目标与更新时间。
   */
  public async setTargets(
    id: string,
    globalTargetCnyFen: number | null,
    regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>,
    updatedAt: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const updated = await transaction.query(
        "UPDATE subscriptions SET global_target_cny_fen = $1, updated_at = $2 WHERE id = $3",
        [globalTargetCnyFen, updatedAt, id],
      );
      if (updated.rowCount !== 1) return false;

      await transaction.query("DELETE FROM subscription_region_targets WHERE subscription_id = $1", [id]);
      for (const target of regionTargets) {
        // 新阈值必须重置为 unmet，防止旧目标已经通知的状态抑制管理员刚设置的新价格提醒。
        await transaction.query(
          `INSERT INTO subscription_region_targets (
             subscription_id, region_code, target_amount_minor, target_state
           ) VALUES ($1, $2, $3, 'unmet')`,
          [id, target.regionCode, target.targetAmountMinor],
        );
      }
      return true;
    });
  }

  /** 查询订阅所属逻辑游戏只返回 ID，供兼容调用与只读校验使用。 */
  public async gameIdForSubscription(id: string): Promise<string | null> {
    const result = await this.database.query<SubscriptionGameRow>(
      `SELECT game_id AS "gameId"
         FROM subscriptions
        WHERE id = $1`,
      [id],
    );
    return result.rows[0]?.gameId ?? null;
  }

  /**
   * 地区替换事务锁定订阅、重读 game_id、验证全部启用商品，再删除旧关系、写新关系并更新时间。
   * 浏览器无法把跨游戏商品混入订阅；任何新关系失败都会恢复旧地区范围和审计时间。
   */
  public async replaceRegionalProductsAtomically(
    id: string,
    regionalProductIds: string[],
    updatedAt: string,
  ): Promise<AtomicRegionalProductReplacementResult> {
    return this.database.transaction(async (transaction) => {
      const owner = await transaction.query<SubscriptionGameRow>(
        `SELECT game_id AS "gameId"
           FROM subscriptions
          WHERE id = $1
          FOR UPDATE`,
        [id],
      );
      const gameId = owner.rows[0]?.gameId;
      if (!gameId) return "not-found";
      if (!(await hasEnabledProductsForGame(transaction, gameId, regionalProductIds))) return "product-mismatch";

      await replaceSubscriptionRegions(transaction, id, regionalProductIds, updatedAt);
      return "updated";
    });
  }

  /** 基础替换方法保留端口兼容，但仍在单个事务中完成删除、插入和更新时间更新。 */
  public async replaceRegionalProducts(id: string, regionalProductIds: string[], updatedAt: string): Promise<void> {
    await this.database.transaction((transaction) => replaceSubscriptionRegions(transaction, id, regionalProductIds, updatedAt));
  }

  /**
   * 永久删除先在事务内按 ID 排序锁定全部目标并验证数量，再按外键和业务保留规则清理。
   * 任一 ID 缺失时不会执行 DELETE；任一中途故障会恢复通知、目标、价格、日志、健康状态及所有主档，汇率/设置/认证永不在范围内。
   */
  public async deleteMany(subscriptionIds: string[]): Promise<boolean> {
    if (subscriptionIds.length === 0) throw new Error("硬删除至少需要一个已验证订阅标识。");
    return this.database.transaction(async (transaction) => {
      const targets = await transaction.query<SubscriptionDeletionTargetRow>(
        `SELECT id, game_id AS "gameId"
           FROM subscriptions
          WHERE id = ANY($1::text[])
          ORDER BY id ASC
          FOR UPDATE`,
        [subscriptionIds],
      );
      if (targets.rows.length !== subscriptionIds.length) return false;

      const gameIds = targets.rows.map((target) => target.gameId);
      await transaction.query(
        `DELETE FROM notification_events
          WHERE subscription_id = ANY($1::text[])
             OR regional_product_id IN (
               SELECT id FROM regional_products WHERE game_id = ANY($2::text[])
             )`,
        [subscriptionIds, gameIds],
      );
      await transaction.query("DELETE FROM subscription_region_targets WHERE subscription_id = ANY($1::text[])", [subscriptionIds]);
      await transaction.query("DELETE FROM subscription_regions WHERE subscription_id = ANY($1::text[])", [subscriptionIds]);
      await transaction.query(
        "DELETE FROM price_snapshots WHERE regional_product_id IN (SELECT id FROM regional_products WHERE game_id = ANY($1::text[]))",
        [gameIds],
      );
      // fetch_logs 的外键是 SET NULL，但管理员明确永久删除时业务规则要求擦除这些专属诊断记录，不能留下无归属日志长期占用空间。
      await transaction.query(
        "DELETE FROM fetch_logs WHERE regional_product_id IN (SELECT id FROM regional_products WHERE game_id = ANY($1::text[]))",
        [gameIds],
      );
      await transaction.query(
        "DELETE FROM regional_product_health WHERE regional_product_id IN (SELECT id FROM regional_products WHERE game_id = ANY($1::text[]))",
        [gameIds],
      );
      await transaction.query("DELETE FROM subscriptions WHERE id = ANY($1::text[])", [subscriptionIds]);
      await transaction.query("DELETE FROM regional_products WHERE game_id = ANY($1::text[])", [gameIds]);
      await transaction.query("DELETE FROM games WHERE id = ANY($1::text[])", [gameIds]);
      return true;
    });
  }

  /** 按稳定 game_id 读取单一订阅，展示名称变化不会造成重复订阅或错误匹配。 */
  public async findByGameId(gameId: string): Promise<SubscriptionRecord | null> {
    const result = await this.database.query<SubscriptionRow>(
      `SELECT subscriptions.id AS id,
              subscriptions.game_id AS "gameId",
              subscriptions.enabled AS enabled,
              subscriptions.created_at AS "createdAt",
              COALESCE(
                ARRAY_AGG(subscription_regions.regional_product_id ORDER BY subscription_regions.regional_product_id)
                  FILTER (WHERE subscription_regions.regional_product_id IS NOT NULL),
                ARRAY[]::TEXT[]
              ) AS "regionalProductIds"
         FROM subscriptions
         LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
        WHERE subscriptions.game_id = $1
        GROUP BY subscriptions.id, subscriptions.game_id, subscriptions.enabled, subscriptions.created_at`,
      [gameId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      gameId: row.gameId,
      enabled: row.enabled,
      createdAt: toIsoString(row.createdAt),
      regionalProductIds: row.regionalProductIds,
    };
  }
}

/** 在已锁定游戏/订阅事务中读取既有订阅 ID，重复提交只返回原 ID 而不覆盖地区。 */
async function findSubscriptionIdByGame(executor: SqlExecutor, gameId: string): Promise<string | null> {
  const result = await executor.query<ExistingSubscriptionIdRow>(
    "SELECT id FROM subscriptions WHERE game_id = $1",
    [gameId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * 用 FOR SHARE 锁定每个启用地区商品并比较去重后的输入长度。
 * 外键只能证明商品存在，无法证明它属于同一游戏或仍启用，因此该业务约束必须在写关系前显式验证。
 */
async function hasEnabledProductsForGame(
  executor: SqlExecutor,
  gameId: string,
  regionalProductIds: string[],
): Promise<boolean> {
  if (regionalProductIds.length === 0 || new Set(regionalProductIds).size !== regionalProductIds.length) return false;
  const result = await executor.query<{ id: string }>(
    `SELECT id
       FROM regional_products
      WHERE game_id = $1
        AND enabled = TRUE
        AND id = ANY($2::text[])
      ORDER BY id ASC
      FOR SHARE`,
    [gameId, regionalProductIds],
  );
  return result.rows.length === regionalProductIds.length;
}

/** 订阅主档与关系表由同一 executor 写入，createdAt/updatedAt 都采用服务端提供的单一审计时刻。 */
async function insertSubscription(executor: SqlExecutor, input: SubscriptionInput): Promise<void> {
  await executor.query(
    "INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, TRUE, $3, $3)",
    [input.id, input.gameId, input.createdAt],
  );
}

/** 关系逐条参数化写入；不存在或跨事务删除的地区商品由外键拒绝并触发整笔回滚。 */
async function insertSubscriptionRegions(
  executor: SqlExecutor,
  subscriptionId: string,
  regionalProductIds: string[],
): Promise<void> {
  for (const regionalProductId of regionalProductIds) {
    await executor.query(
      "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)",
      [subscriptionId, regionalProductId],
    );
  }
}

/** 删除旧关系、写新关系和更新时间共享 executor，任何失败都会保留管理员原来的地区范围。 */
async function replaceSubscriptionRegions(
  executor: SqlExecutor,
  subscriptionId: string,
  regionalProductIds: string[],
  updatedAt: string,
): Promise<void> {
  await executor.query("DELETE FROM subscription_regions WHERE subscription_id = $1", [subscriptionId]);
  await insertSubscriptionRegions(executor, subscriptionId, regionalProductIds);
  await executor.query("UPDATE subscriptions SET updated_at = $1 WHERE id = $2", [updatedAt, subscriptionId]);
}

/** 将 TIMESTAMPTZ 统一为旧 API 使用的 UTC ISO 字符串，避免 Date 进入服务或 JSON 序列化边界。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("订阅创建时间无效。");
  return date.toISOString();
}
