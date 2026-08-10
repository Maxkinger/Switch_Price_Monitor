import type { AppDatabase } from "../../server/database/types";
import type { SubscriptionInput, SubscriptionRecord } from "../../shared/domain";
import type { SubscriptionStore } from "../ports";

interface CountRow { count: string; }
interface GameIdRow { gameId: string; }
interface SubscriptionRow {
  id: string;
  gameId: string;
  enabled: boolean;
  createdAt: Date;
  regionalProductIds: string[];
}

/**
 * PostgreSQL 订阅读写仓储。
 * Task 3 的读取与归属验证继续复用参数化池查询；Task 4 的创建、编辑及永久删除使用显式事务，
 * 多语句路径只能使用回调执行器，不能把独立 pool 查询误当成原子写入。
 */
export class PostgresSubscriptionRepository implements SubscriptionStore {
  public constructor(private readonly database: AppDatabase) {}

  public async hasEnabledProductsForGame(gameId: string, regionalProductIds: string[]): Promise<boolean> {
    if (regionalProductIds.length === 0) return false;
    const uniqueIds = [...new Set(regionalProductIds)];
    if (uniqueIds.length !== regionalProductIds.length) return false;
    const result = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count
         FROM regional_products
        WHERE game_id = $1
          AND enabled IS TRUE
          AND id = ANY($2::text[])`,
      [gameId, uniqueIds],
    );
    return parseSafeCount(result.rows[0]?.count ?? "0") === uniqueIds.length;
  }

  public async gameIdForSubscription(id: string): Promise<string | null> {
    const result = await this.database.query<GameIdRow>(
      `SELECT game_id AS "gameId"
         FROM subscriptions
        WHERE id = $1`,
      [id],
    );
    return result.rows[0]?.gameId ?? null;
  }

  public async findByGameId(gameId: string): Promise<SubscriptionRecord | null> {
    const result = await this.database.query<SubscriptionRow>(
      `SELECT subscriptions.id,
              subscriptions.game_id AS "gameId",
              subscriptions.enabled,
              subscriptions.created_at AS "createdAt",
              COALESCE(
                ARRAY_AGG(subscription_regions.regional_product_id ORDER BY subscription_regions.regional_product_id)
                  FILTER (WHERE subscription_regions.regional_product_id IS NOT NULL),
                ARRAY[]::text[]
              ) AS "regionalProductIds"
         FROM subscriptions
         LEFT JOIN subscription_regions
           ON subscription_regions.subscription_id = subscriptions.id
        WHERE subscriptions.game_id = $1
        GROUP BY subscriptions.id,
                 subscriptions.game_id,
                 subscriptions.enabled,
                 subscriptions.created_at`,
      [gameId],
    );
    const row = result.rows[0];
    return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
  }

  public async create(input: SubscriptionInput): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // 主订阅和全部地区关系只在同一事务连接上写入，任一外键故障都不能留下无地区的半成品订阅。
      await transaction.query(
        `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
         VALUES ($1, $2, TRUE, $3, $3)`,
        [input.id, input.gameId, input.createdAt],
      );
      for (const regionalProductId of input.regionalProductIds) {
        await transaction.query(
          `INSERT INTO subscription_regions (subscription_id, regional_product_id)
           VALUES ($1, $2)`,
          [input.id, regionalProductId],
        );
      }
    });
  }

  public async setEnabled(id: string, enabled: boolean, updatedAt: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE subscriptions
          SET enabled = $1,
              updated_at = $2
        WHERE id = $3`,
      [enabled, updatedAt, id],
    );
    return result.rowCount === 1;
  }

  public async replaceRegionalProducts(
    id: string,
    regionalProductIds: string[],
    updatedAt: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        "DELETE FROM subscription_regions WHERE subscription_id = $1",
        [id],
      );
      for (const regionalProductId of regionalProductIds) {
        await transaction.query(
          `INSERT INTO subscription_regions (subscription_id, regional_product_id)
           VALUES ($1, $2)`,
          [id, regionalProductId],
        );
      }
      await transaction.query(
        "UPDATE subscriptions SET updated_at = $1 WHERE id = $2",
        [updatedAt, id],
      );
    });
  }

  public async deleteMany(subscriptionIds: string[]): Promise<boolean> {
    if (subscriptionIds.length === 0 || new Set(subscriptionIds).size !== subscriptionIds.length) {
      throw new Error("永久删除需要非空且不重复的订阅标识。");
    }
    return this.database.transaction(async (transaction) => {
      // 在第一条写入前锁定并验证全量目标；缺失任一 ID 时直接返回 false，绝不删除仍存在的部分。
      const targets = await transaction.query<{ id: string; gameId: string }>(
        `SELECT id, game_id AS "gameId"
           FROM subscriptions
          WHERE id = ANY($1::text[])
          FOR UPDATE`,
        [subscriptionIds],
      );
      if (targets.rows.length !== subscriptionIds.length) return false;
      const gameIds = targets.rows.map((target) => target.gameId);

      /**
       * 显式清理顺序遵守 RESTRICT 外键，并把管理员要求的永久删除扩展到快照、日志、健康与通知审计。
       * 设置、汇率和认证表不在目标游戏范围内，任何语句故障都会由同一事务回滚。
       */
      await transaction.query(
        `DELETE FROM notification_events
          WHERE subscription_id = ANY($1::text[])
             OR regional_product_id IN (
                  SELECT id FROM regional_products WHERE game_id = ANY($2::text[])
                )`,
        [subscriptionIds, gameIds],
      );
      await transaction.query(
        "DELETE FROM subscription_regions WHERE subscription_id = ANY($1::text[])",
        [subscriptionIds],
      );
      for (const table of ["price_snapshots", "fetch_logs", "regional_product_health"] as const) {
        // 表名来自封闭常量，不含请求值；游戏 ID 仍使用参数绑定，避免动态输入进入 SQL 结构。
        await transaction.query(
          `DELETE FROM ${table}
            WHERE regional_product_id IN (
              SELECT id FROM regional_products WHERE game_id = ANY($1::text[])
            )`,
          [gameIds],
        );
      }
      await transaction.query(
        "DELETE FROM subscriptions WHERE id = ANY($1::text[])",
        [subscriptionIds],
      );
      await transaction.query(
        "DELETE FROM regional_products WHERE game_id = ANY($1::text[])",
        [gameIds],
      );
      await transaction.query(
        "DELETE FROM games WHERE id = ANY($1::text[])",
        [gameIds],
      );
      return true;
    });
  }
}

/** COUNT/BIGINT 必须先用 bigint 校验安全范围，不能依赖隐式字符串比较或 Number 舍入。 */
function parseSafeCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("PostgreSQL count 不是非负整数");
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PostgreSQL count 超出 JavaScript 安全整数范围");
  return Number(count);
}
