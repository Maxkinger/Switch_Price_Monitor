import type { ProductType } from "../../providers/types";
import type { RegionCode } from "../../shared/domain";
import type { AppDatabase, SqlExecutor } from "../../server/database/types";
import type {
  ExistingSubscriptionConfirmation,
  ExistingSubscriptionRegionCompletion,
  SubscriptionConfirmationStore,
  ValidatedConfirmedRegion,
  ValidatedSubscriptionConfirmation,
} from "../ports";

interface ExistingRow {
  normalizedName: string;
  gameId: string;
  subscriptionId: string;
}

interface CompletionAnchorRow {
  subscriptionId: string;
  gameId: string;
  regionCode: RegionCode;
  productUrl: string;
  currency: string;
  nameEn: string;
  publisher: string | null;
  productType: ProductType;
  coverUrl: string | null;
}

/** 并发规范化游戏唯一冲突只暴露稳定业务码，禁止把 PostgreSQL 表名、约束名或 SQLSTATE 传给路由。 */
export class SubscriptionWriteConflictError extends Error {
  public readonly code = "SUBSCRIPTION_WRITE_CONFLICT";

  public constructor() {
    super("同一游戏已被并发确认。");
  }
}

/**
 * PostgreSQL 最终确认仓储只接受服务已从官方来源重验的 DTO。
 * 新游戏和已有订阅补全的所有写入都只使用 transaction 回调的 SqlExecutor，
 * 任一唯一约束、外键或注入故障都会回滚整组实体，不能留下可被采集器读取的半成品。
 */
export class PostgresSubscriptionConfirmationRepository implements SubscriptionConfirmationStore {
  public constructor(private readonly database: AppDatabase) {}

  public async findExistingByNormalizedNames(
    normalizedNames: string[],
  ): Promise<Map<string, ExistingSubscriptionConfirmation>> {
    if (normalizedNames.length === 0) return new Map();
    const result = await this.database.query<ExistingRow>(
      `SELECT games.normalized_name AS "normalizedName",
              games.id AS "gameId",
              subscriptions.id AS "subscriptionId"
         FROM games
         INNER JOIN subscriptions ON subscriptions.game_id = games.id
        WHERE games.normalized_name = ANY($1::text[])`,
      [normalizedNames],
    );
    return new Map(result.rows.map((row) => [row.normalizedName, row]));
  }

  public async createAtomically(
    inputs: ValidatedSubscriptionConfirmation[],
    now: string,
  ): Promise<void> {
    if (inputs.length === 0) return;
    try {
      await this.database.transaction(async (transaction) => {
        for (const input of inputs) {
          await insertGame(transaction, input, now);
          for (const region of input.regions) {
            await insertRegion(transaction, input.game.id, region, now);
          }
          await transaction.query(
            `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
             VALUES ($1, $2, TRUE, $3, $3)`,
            [input.subscriptionId, input.game.id, now],
          );
          for (const region of input.regions) {
            await transaction.query(
              `INSERT INTO subscription_regions (subscription_id, regional_product_id)
               VALUES ($1, $2)`,
              [input.subscriptionId, region.id],
            );
          }
        }
      });
    } catch (error) {
      // 唯一冲突是并发确认的可预期最终裁决；其他外键、连接或注入故障必须原样抛出供事务回滚处理。
      if (isUniqueViolation(error)) throw new SubscriptionWriteConflictError();
      throw error;
    }
  }

  public async findForRegionCompletion(
    subscriptionId: string,
  ): Promise<ExistingSubscriptionRegionCompletion | null> {
    const anchorResult = await this.database.query<CompletionAnchorRow>(
      `SELECT subscriptions.id AS "subscriptionId",
              games.id AS "gameId",
              products.region_code AS "regionCode",
              products.product_url AS "productUrl",
              products.currency,
              games.name_en AS "nameEn",
              games.publisher,
              games.product_type AS "productType",
              games.cover_url AS "coverUrl"
         FROM subscriptions
         INNER JOIN games ON games.id = subscriptions.game_id
         INNER JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
         INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
        WHERE subscriptions.id = $1
        ORDER BY products.created_at ASC, products.id ASC
        LIMIT 1`,
      [subscriptionId],
    );
    const anchor = anchorResult.rows[0];
    if (!anchor) return null;
    const regionResult = await this.database.query<{ regionCode: RegionCode }>(
      `SELECT products.region_code AS "regionCode"
         FROM subscription_regions
         INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
        WHERE subscription_regions.subscription_id = $1
        ORDER BY products.region_code ASC`,
      [subscriptionId],
    );
    return {
      subscriptionId: anchor.subscriptionId,
      gameId: anchor.gameId,
      anchor: {
        regionCode: anchor.regionCode,
        productUrl: anchor.productUrl,
        canonicalTitle: anchor.nameEn,
        publisher: anchor.publisher,
        productType: anchor.productType,
        currency: anchor.currency,
        coverUrl: anchor.coverUrl,
        currentPriceMinor: null,
        regularPriceMinor: null,
      },
      existingRegionCodes: regionResult.rows.map((row) => row.regionCode),
    };
  }

  public async completeAtomically(
    subscriptionId: string,
    gameId: string,
    regions: ValidatedConfirmedRegion[],
    now: string,
  ): Promise<void> {
    if (regions.length === 0) return;
    await this.database.transaction(async (transaction) => {
      for (const region of regions) {
        await insertRegion(transaction, gameId, region, now);
        await transaction.query(
          `INSERT INTO subscription_regions (subscription_id, regional_product_id)
           VALUES ($1, $2)`,
          [subscriptionId, region.id],
        );
      }
    });
  }
}

/** 只识别 PostgreSQL 标准 unique_violation；结构检查不导入或向上暴露 pg 的驱动错误类型。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * 游戏身份字段与展示名称决议全部来自确认服务；normalized_name 依赖唯一索引提供并发最终裁决。
 * name_zh 仅保留兼容副本，新读取模型必须直接使用 display_name_zh_cn，且来源与确认时刻在同一事务落库以保持审计一致。
 */
async function insertGame(
  transaction: SqlExecutor,
  input: ValidatedSubscriptionConfirmation,
  now: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO games (
       id, name_zh, display_name_zh_cn, display_name_source, display_name_confirmed_at,
       name_en, normalized_name, publisher, product_type, cover_url, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.game.id,
      input.game.nameZh,
      input.game.displayNameZhCn,
      input.game.displayNameSource,
      now,
      input.game.nameEn,
      input.game.normalizedName,
      input.game.publisher,
      input.game.productType,
      input.game.coverUrl,
      now,
    ],
  );
}

/** 地区商品只保存官方复核后的 URL、币种和价格 ID；布尔字段使用 PostgreSQL 原生 TRUE。 */
async function insertRegion(
  transaction: SqlExecutor,
  gameId: string,
  region: ValidatedConfirmedRegion,
  now: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO regional_products (
       id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)`,
    [
      region.id,
      gameId,
      region.regionCode,
      region.currency,
      region.officialPriceId,
      region.productUrl,
      region.matchSource,
      now,
    ],
  );
}
