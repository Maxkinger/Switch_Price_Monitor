import type { ProductType } from "../../providers/types";
import type { AppDatabase, SqlExecutor } from "../../server/database/types";
import type { RegionCode } from "../../shared/domain";
import type {
  ExistingSubscriptionConfirmation,
  ExistingSubscriptionRegionCompletion,
  SubscriptionConfirmationStore,
  ValidatedConfirmedRegion,
  ValidatedSubscriptionConfirmation,
} from "../ports";

/** 规范化身份查询只返回服务幂等投影所需字段，价格历史、URL 和设置均不越过该边界。 */
interface ExistingSubscriptionRow {
  normalizedName: string;
  gameId: string;
  subscriptionId: string;
}

/** 补全锚点来自订阅已监控关系；历史价格刻意不读取，避免旧快照被误当作当前官方证据。 */
interface ExistingSubscriptionCompletionAnchorRow {
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

/** 补全只把当前订阅实际选择的地区视为既有；同游戏但未监控的商品不能静默跳过管理员确认。 */
interface ExistingSubscriptionRegionRow {
  regionCode: RegionCode;
}

/** 追加补全前锁定订阅并重验 game_id，防止外部官方验证期间订阅被删除或换成其他逻辑游戏。 */
interface CompletionOwnerRow {
  gameId: string;
}

/**
 * PostgreSQL 最终确认与地区补全仓储。
 * 所有任天堂页面、Browser Run 与价格 ID 网络验证必须先在服务层完成；仓储事务只保存已验证模型，缩短连接占用并确保失败零部分写入。
 */
export class SubscriptionConfirmationRepository implements SubscriptionConfirmationStore {
  public constructor(private readonly database: AppDatabase) {}

  /** 批量查重使用一个 TEXT[] 参数，规范化名称只作内部身份键，不会进入浏览器响应。 */
  public async findExistingByNormalizedNames(normalizedNames: string[]): Promise<Map<string, ExistingSubscriptionConfirmation>> {
    if (normalizedNames.length === 0) return new Map();
    const result = await this.database.query<ExistingSubscriptionRow>(
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

  /**
   * 整批新游戏共享一个事务；每条 INSERT 都显式接收 transaction executor，绝不能回退到池级 query。
   * 任一地区唯一约束、外键或连接故障会回滚本批的游戏、地区商品、订阅与关系，避免采集器读取半成品来源。
   */
  public async createAtomically(inputs: ValidatedSubscriptionConfirmation[], now: string): Promise<void> {
    if (inputs.length === 0) return;
    await this.database.transaction(async (transaction) => {
      for (const input of inputs) {
        await insertGame(transaction, input, now);
        await insertRegionalProducts(transaction, input.game.id, input.regions, now);
        await insertSubscription(transaction, input, now);
        await insertSubscriptionRegions(transaction, input.subscriptionId, input.regions);
      }
    });
  }

  /**
   * 读取补全锚点后服务仍会重新请求任天堂官方来源；数据库中的标题、发行商、URL 和币种只用于定位，不能单独授权写入。
   * 两条只读查询不持有长事务，避免外部网络复核期间占用连接；真正追加时会再次锁定并核对订阅归属。
   */
  public async findForRegionCompletion(subscriptionId: string): Promise<ExistingSubscriptionRegionCompletion | null> {
    const anchorResult = await this.database.query<ExistingSubscriptionCompletionAnchorRow>(
      `SELECT subscriptions.id AS "subscriptionId",
              games.id AS "gameId",
              products.region_code AS "regionCode",
              products.product_url AS "productUrl",
              products.currency AS currency,
              games.name_en AS "nameEn",
              games.publisher AS publisher,
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

    const regionResult = await this.database.query<ExistingSubscriptionRegionRow>(
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

  /**
   * 补全事务先锁定订阅并重验 game_id，再为全部新地区写商品和关系。
   * 删除若先提交会得到稳定缺失错误；补全若先提交，随后硬删除会在同一所有权图中清理新增来源，不能留下孤儿商品。
   */
  public async completeAtomically(subscriptionId: string, gameId: string, regions: ValidatedConfirmedRegion[], now: string): Promise<void> {
    if (regions.length === 0) return;
    await this.database.transaction(async (transaction) => {
      const owner = await transaction.query<CompletionOwnerRow>(
        `SELECT game_id AS "gameId"
           FROM subscriptions
          WHERE id = $1
          FOR UPDATE`,
        [subscriptionId],
      );
      if (owner.rows[0]?.gameId !== gameId) throw new Error("订阅补全目标已变化。");

      await insertRegionalProducts(transaction, gameId, regions, now);
      await insertSubscriptionRegions(transaction, subscriptionId, regions);
    });
  }
}

/** 游戏主档保存官方标题、受控中文显示名与规范化身份；服务端 ID 防止浏览器覆盖既有逻辑商品。 */
async function insertGame(executor: SqlExecutor, input: ValidatedSubscriptionConfirmation, now: string): Promise<void> {
  await executor.query(
    `INSERT INTO games (
       id, name_zh, name_en, normalized_name, publisher, product_type, cover_url, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.game.id,
      input.game.nameZh,
      input.game.nameEn,
      input.game.normalizedName,
      input.game.publisher,
      input.game.productType,
      input.game.coverUrl,
      now,
    ],
  );
}

/** 地区商品只保存本次官方复核后的 URL、币种、价格 ID 与匹配来源；enabled 使用 PostgreSQL BOOLEAN。 */
async function insertRegionalProducts(
  executor: SqlExecutor,
  gameId: string,
  regions: ValidatedConfirmedRegion[],
  now: string,
): Promise<void> {
  for (const region of regions) {
    await executor.query(
      `INSERT INTO regional_products (
         id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)`,
      [region.id, gameId, region.regionCode, region.currency, region.officialPriceId, region.productUrl, region.matchSource, now],
    );
  }
}

/** 订阅主档在地区商品之后创建，关系写入前已具备全部父记录；事务失败仍会统一回滚。 */
async function insertSubscription(executor: SqlExecutor, input: ValidatedSubscriptionConfirmation, now: string): Promise<void> {
  await executor.query(
    "INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES ($1, $2, TRUE, $3, $3)",
    [input.subscriptionId, input.game.id, now],
  );
}

/** 订阅关系逐条使用同一个 executor，任何缺失父记录或重复主键都会取消整批确认/补全。 */
async function insertSubscriptionRegions(
  executor: SqlExecutor,
  subscriptionId: string,
  regions: ValidatedConfirmedRegion[],
): Promise<void> {
  for (const region of regions) {
    await executor.query(
      "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)",
      [subscriptionId, region.id],
    );
  }
}
