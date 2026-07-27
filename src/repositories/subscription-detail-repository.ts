/**
 * 订阅详情的单笔价格快照。金额始终沿用数据库中的最小货币单位与人民币分，
 * 使浏览器只负责格式化而不会重新计算汇率、误把缺失值当成零或伪装价格来源。
 */
export interface SubscriptionDetailPriceSnapshot {
  amountMinor: number;
  cnyFen: number | null;
  source: string;
  capturedAt: string;
}

/**
 * 已确认地区商品的详情行。`monitored` 与商品确认状态分离：前者只表示当前订阅是否采集它，
 * 后者已经由地区商品写入流程保证，因而详情页只能在这些受控 ID 之间编辑，不能输入任意商品 ID。
 */
export interface SubscriptionDetailRegion {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  monitored: boolean;
  current: SubscriptionDetailPriceSnapshot | null;
  historicalLow: SubscriptionDetailPriceSnapshot | null;
  isStale: boolean;
}

/**
 * Worker 对浏览器承诺的订阅详情读取模型。它刻意不含会话、恢复码、Telegram 配置、商品 URL、
 * 来源原始响应或数据库错误，从而让详情页获得所需业务数据但不会扩大管理员敏感配置的暴露面。
 */
export interface SubscriptionDetail {
  subscriptionId: string;
  game: {
    id: string;
    nameZh: string;
    nameEn: string;
    productType: string;
  };
  enabled: boolean;
  globalTargetCnyFen: number | null;
  regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>;
  regions: SubscriptionDetailRegion[];
}

/** 订阅与游戏联表后的基础行；不存在时仓储返回 null，由服务层转换为安全的业务 404。 */
interface SubscriptionDetailRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  productType: string;
  enabled: number;
  globalTargetCnyFen: number | null;
}

/** 目标价表只暴露展示和编辑所需的地区代码与最小货币单位，不返回内部命中状态。 */
interface RegionTargetRow {
  regionCode: string;
  targetAmountMinor: number;
}

/**
 * 通过相关子查询读取最新和本币历史最低快照的 D1 行。`isStale` 仍需同时判断最新价格存在，
 * 这样“从未采集”与“上次成功后连续失败”不会在 UI 中被混为同一种故障状态。
 */
interface RegionDetailRow {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  monitored: number;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: string | null;
  currentCapturedAt: string | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: string | null;
  lowCapturedAt: string | null;
  consecutiveFailures: number | null;
}

/**
 * 订阅详情读取仓储。所有值都通过参数化绑定传入；订阅 ID 不会拼接进 SQL，
 * 防止地址栏参数影响查询结构，同时让服务层保持完全不知道 D1 行和联接细节。
 */
export class SubscriptionDetailRepository {
  public constructor(private readonly database: D1Database) {}

  /**
   * 读取单个订阅的游戏身份、受控地区、价格快照和目标价。地区查询以游戏为范围读取全部现有地区商品，
   * 而非只读取 subscription_regions，确保管理员能安全地重新勾选此前已经官方确认但暂未监控的地区。
   */
  public async find(subscriptionId: string): Promise<SubscriptionDetail | null> {
    const subscription = await this.database
      .prepare(
        `SELECT subscriptions.id AS subscriptionId, games.id AS gameId,
                games.name_zh AS nameZh, games.name_en AS nameEn, games.product_type AS productType,
                subscriptions.enabled AS enabled, subscriptions.global_target_cny_fen AS globalTargetCnyFen
         FROM subscriptions
         INNER JOIN games ON games.id = subscriptions.game_id
         WHERE subscriptions.id = ?`,
      )
      .bind(subscriptionId)
      .first<SubscriptionDetailRow>();
    if (!subscription) return null;

    const [targets, regions] = await Promise.all([
      // 单区目标价按地区代码稳定排序，避免无价格变化时浏览器列表因数据库返回顺序而跳动。
      this.database
        .prepare(
          `SELECT region_code AS regionCode, target_amount_minor AS targetAmountMinor
           FROM subscription_region_targets
           WHERE subscription_id = ?
           ORDER BY region_code ASC`,
        )
        .bind(subscriptionId)
        .all<RegionTargetRow>(),
      // 相关子查询在每个地区商品内独立选择最新与最低快照；捕获时间相同时用主键消除并列，保证历史显示可复现。
      this.database
        .prepare(
          `SELECT products.id AS regionalProductId, products.region_code AS regionCode, products.currency AS currency,
                  CASE WHEN subscription_regions.regional_product_id IS NULL THEN 0 ELSE 1 END AS monitored,
                  latest.amount_minor AS currentAmountMinor, latest.cny_fen AS currentCnyFen,
                  latest.source AS currentSource, latest.captured_at AS currentCapturedAt,
                  lowest.amount_minor AS lowAmountMinor, lowest.cny_fen AS lowCnyFen,
                  lowest.source AS lowSource, lowest.captured_at AS lowCapturedAt,
                  health.consecutive_failures AS consecutiveFailures
           FROM regional_products AS products
           LEFT JOIN subscription_regions
             ON subscription_regions.regional_product_id = products.id
            AND subscription_regions.subscription_id = ?
           LEFT JOIN price_snapshots AS latest ON latest.id = (
             SELECT id FROM price_snapshots
             WHERE regional_product_id = products.id
             ORDER BY captured_at DESC, id DESC
             LIMIT 1
           )
           LEFT JOIN price_snapshots AS lowest ON lowest.id = (
             SELECT id FROM price_snapshots
             WHERE regional_product_id = products.id
             ORDER BY amount_minor ASC, captured_at ASC, id ASC
             LIMIT 1
           )
           LEFT JOIN regional_product_health AS health ON health.regional_product_id = products.id
           WHERE products.game_id = ? AND products.enabled = 1
           -- 先展示当前订阅正在监控的地区，方便管理员核对采集范围；同组内再用创建时间和 ID 固定顺序，避免页面无原因跳动。
           ORDER BY monitored DESC, products.created_at ASC, products.id ASC`,
        )
        .bind(subscriptionId, subscription.gameId)
        .all<RegionDetailRow>(),
    ]);

    return {
      subscriptionId: subscription.subscriptionId,
      game: {
        id: subscription.gameId,
        nameZh: subscription.nameZh,
        nameEn: subscription.nameEn,
        productType: subscription.productType,
      },
      enabled: subscription.enabled === 1,
      globalTargetCnyFen: subscription.globalTargetCnyFen,
      regionTargets: targets.results.map((target) => ({
        regionCode: target.regionCode,
        targetAmountMinor: target.targetAmountMinor,
      })),
      regions: regions.results.map((region) => ({
        regionalProductId: region.regionalProductId,
        regionCode: region.regionCode,
        currency: region.currency,
        monitored: region.monitored === 1,
        current: this.toPriceSnapshot(region.currentAmountMinor, region.currentCnyFen, region.currentSource, region.currentCapturedAt),
        historicalLow: this.toPriceSnapshot(region.lowAmountMinor, region.lowCnyFen, region.lowSource, region.lowCapturedAt),
        // 仅已有可展示价格且采集在其后连续失败时标记过期；没有快照时 UI 应显示“等待首笔价格”。
        isStale: region.currentCapturedAt !== null && (region.consecutiveFailures ?? 0) > 0,
      })),
    };
  }

  /**
   * D1 LEFT JOIN 的四个空列代表不存在快照。捕获时间是快照存在的唯一可靠标志，
   * 其余字段即使因未来数据修复为 null 也不应构造半截价格对象并让前端误格式化。
   */
  private toPriceSnapshot(amountMinor: number | null, cnyFen: number | null, source: string | null, capturedAt: string | null): SubscriptionDetailPriceSnapshot | null {
    if (capturedAt === null || amountMinor === null || source === null) return null;
    return { amountMinor, cnyFen, source, capturedAt };
  }
}
