import type { SqlExecutor } from "../../server/database/types";
import type { SubscriptionRecord } from "../../shared/domain";
import type { SubscriptionReader } from "../ports";

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
 * PostgreSQL 订阅读取仓储。
 * Task 3 只提供查询和写入前归属验证；创建、编辑及永久删除事务明确留给 Task 4，
 * 从而不会把独立 pool 查询误当成原子写路径。
 */
export class PostgresSubscriptionRepository implements SubscriptionReader {
  public constructor(private readonly database: SqlExecutor) {}

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
}

/** COUNT/BIGINT 必须先用 bigint 校验安全范围，不能依赖隐式字符串比较或 Number 舍入。 */
function parseSafeCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("PostgreSQL count 不是非负整数");
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PostgreSQL count 超出 JavaScript 安全整数范围");
  return Number(count);
}
