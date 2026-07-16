import type { SubscriptionInput, SubscriptionRecord } from "../../shared/domain";

interface SubscriptionRow {
  id: string;
  gameId: string;
  enabled: number;
  createdAt: string;
  regionalProductIds: string | null;
}

export class SubscriptionRepository {
  public constructor(private readonly database: D1Database) {}

  public async create(input: SubscriptionInput): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .bind(input.id, input.gameId, input.createdAt, input.createdAt)
      .run();

    await this.database.batch(
      input.regionalProductIds.map((regionalProductId) =>
        this.database
          .prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
          .bind(input.id, regionalProductId),
      ),
    );
  }

  public async findByGameId(gameId: string): Promise<SubscriptionRecord | null> {
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

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      gameId: row.gameId,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      regionalProductIds: row.regionalProductIds?.split(",") ?? [],
    };
  }
}
