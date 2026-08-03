import type { SqlExecutor } from "../../server/database/types";
import type { SubscriptionRecord } from "../../shared/domain";
import type { SubscriptionReader } from "../ports";

/** PostgreSQL ARRAY_AGG、BOOLEAN 与 TIMESTAMPTZ 解码后的内部行，返回前转换为既有订阅领域模型。 */
interface SubscriptionRow {
  id: string;
  gameId: string;
  enabled: boolean;
  createdAt: Date | string;
  regionalProductIds: string[];
}

/**
 * PostgreSQL 订阅读取仓储只实现 Task 3 所需查询。
 * 创建、目标价替换、地区替换和硬删除属于 Task 4 的显式事务边界，本类不得用独立池查询提前模拟这些写入。
 */
export class SubscriptionRepository implements SubscriptionReader {
  public constructor(private readonly database: SqlExecutor) {}

  /** 按稳定游戏 ID 查找单一订阅；标题本地化变化不会造成重复订阅或错误匹配。 */
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

/** 将 TIMESTAMPTZ 统一为旧 API 使用的 UTC ISO 字符串，避免 Date 进入服务或 JSON 序列化边界。 */
function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("订阅创建时间无效。");
  return date.toISOString();
}
