import type { ProductType } from "../providers/types";
import type { OfficialProductCandidate, RegionalProductMatchSource, RegionCode } from "../../shared/domain";

/** 已有订阅只返回确认服务决定幂等结果所需的两个标识，避免仓储把历史地区范围交给新建流程误写。 */
export interface ExistingSubscriptionConfirmation {
  normalizedName: string;
  gameId: string;
  subscriptionId: string;
}

/** 经官方页面和官方价格 ID 服务重新验证后的单区写入模型；浏览器原始候选不会直接进入此仓储。 */
export interface ValidatedConfirmedRegion {
  id: string;
  regionCode: RegionCode;
  currency: string;
  officialPriceId: string | null;
  productUrl: string;
  matchSource: RegionalProductMatchSource;
}

/** 一条新订阅的完整原子写入数据，所有 ID 均由服务端生成以阻止浏览器覆盖或猜测业务主键。 */
export interface ValidatedSubscriptionConfirmation {
  game: {
    id: string;
    nameZh: string;
    nameEn: string;
    normalizedName: string;
    publisher: string | null;
    productType: ProductType;
    coverUrl: string | null;
  };
  subscriptionId: string;
  regions: ValidatedConfirmedRegion[];
}

/**
 * 已有订阅补全所需的受控锚点。该锚点只从订阅、游戏与已监控地区商品联表读取，
 * 浏览器既不能指定游戏归属，也不能把另一个订阅的商品 URL 伪装成当前补全的身份起点。
 */
export interface ExistingSubscriptionRegionCompletion {
  subscriptionId: string;
  gameId: string;
  anchor: OfficialProductCandidate;
  existingRegionCodes: RegionCode[];
}

/** D1 行别名只在仓储内部使用，避免 SQL 的蛇形命名泄漏到确认服务与 HTTP 响应。 */
interface ExistingSubscriptionRow {
  normalizedName: string;
  gameId: string;
  subscriptionId: string;
}

/** D1 联表行仅用于重建官方复核前的锚点，价格字段刻意为空，避免旧快照被误当作当前公开价格。 */
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

/** 已监控地区代码只来自订阅关联，补全不会因为同游戏的未监控候选而错误跳过管理员选择。 */
interface ExistingSubscriptionRegionRow {
  regionCode: RegionCode;
}

/**
 * 最终订阅确认的唯一持久化边界。它先只读查找既有规范化游戏身份，再把新游戏、地区商品、订阅及关联交给同一 D1 批次，
 * 防止其中一条 SQL 成功而另一条失败时留下会被采集器误用的半成品记录。
 */
export class SubscriptionConfirmationRepository {
  public constructor(private readonly database: D1Database) {}

  /**
   * 只查询已有逻辑游戏的订阅。调用方已在服务层去重，所以这里不接受空数组，避免生成无意义的 `IN ()` SQL。
   * 规范化身份而非展示标题用于去重，防止同款商品在大小写或多余空白变化时被重复订阅。
   */
  public async findExistingByNormalizedNames(normalizedNames: string[]): Promise<Map<string, ExistingSubscriptionConfirmation>> {
    if (normalizedNames.length === 0) return new Map();
    const placeholders = normalizedNames.map(() => "?").join(", ");
    const result = await this.database
      .prepare(
        `SELECT games.normalized_name AS normalizedName, games.id AS gameId, subscriptions.id AS subscriptionId
         FROM games
         INNER JOIN subscriptions ON subscriptions.game_id = games.id
         WHERE games.normalized_name IN (${placeholders})`,
      )
      .bind(...normalizedNames)
      .all<ExistingSubscriptionRow>();
    return new Map(result.results.map((row) => [row.normalizedName, row]));
  }

  /**
   * 所有新建实体都在一个 `database.batch` 中提交。服务在调用前已完成官方链接、地区、货币、类型和价格 ID 验证；
   * 因而批次只负责以参数化 SQL 保存受控数据，任一语句失败时 D1 的批处理原子语义不会留下部分游戏或订阅。
   */
  public async createAtomically(inputs: ValidatedSubscriptionConfirmation[], now: string): Promise<void> {
    if (inputs.length === 0) return;
    await this.database.batch(inputs.flatMap((input) => [
      this.database
        .prepare(
          "INSERT INTO games (id, name_zh, name_en, normalized_name, publisher, product_type, cover_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(input.game.id, input.game.nameZh, input.game.nameEn, input.game.normalizedName, input.game.publisher, input.game.productType, input.game.coverUrl, now),
      ...input.regions.map((region) => this.database
        .prepare("INSERT INTO regional_products (id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)")
        .bind(region.id, input.game.id, region.regionCode, region.currency, region.officialPriceId, region.productUrl, region.matchSource, now)),
      this.database
        .prepare("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
        .bind(input.subscriptionId, input.game.id, now, now),
      ...input.regions.map((region) => this.database
        .prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
        .bind(input.subscriptionId, region.id)),
    ]));
  }

  /**
   * 读取已有订阅可复核的官方锚点及其已监控地区。锚点随后仍由服务重新请求任天堂页面，
   * 因此这里的历史标题、发行商和 URL 只用于定位，不能单独授权新增跨区商品。
   */
  public async findForRegionCompletion(subscriptionId: string): Promise<ExistingSubscriptionRegionCompletion | null> {
    const anchor = await this.database
      .prepare(
        `SELECT subscriptions.id AS subscriptionId, games.id AS gameId,
                products.region_code AS regionCode, products.product_url AS productUrl, products.currency AS currency,
                games.name_en AS nameEn, games.publisher AS publisher, games.product_type AS productType, games.cover_url AS coverUrl
         FROM subscriptions
         INNER JOIN games ON games.id = subscriptions.game_id
         INNER JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
         INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
         WHERE subscriptions.id = ?
         ORDER BY products.created_at ASC, products.id ASC
         LIMIT 1`,
      )
      .bind(subscriptionId)
      .first<ExistingSubscriptionCompletionAnchorRow>();
    if (!anchor) return null;
    const regions = await this.database
      .prepare(
        `SELECT products.region_code AS regionCode
         FROM subscription_regions
         INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
         WHERE subscription_regions.subscription_id = ?
         ORDER BY products.region_code ASC`,
      )
      .bind(subscriptionId)
      .all<ExistingSubscriptionRegionRow>();
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
      existingRegionCodes: regions.results.map((region) => region.regionCode),
    };
  }

  /**
   * 在同一 D1 批次中仅追加新地区商品与订阅关联。调用方已排除既有地区并完成官方复核，
   * 所以任一唯一约束、外键或写入错误都会让整个批次回滚，既有快照、目标价和订阅状态不会被触碰。
   */
  public async completeAtomically(subscriptionId: string, gameId: string, regions: ValidatedConfirmedRegion[], now: string): Promise<void> {
    if (regions.length === 0) return;
    await this.database.batch(regions.flatMap((region) => [
      this.database
        .prepare("INSERT INTO regional_products (id, game_id, region_code, currency, official_product_id, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)")
        .bind(region.id, gameId, region.regionCode, region.currency, region.officialPriceId, region.productUrl, region.matchSource, now),
      this.database
        .prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
        .bind(subscriptionId, region.id),
    ]));
  }
}
