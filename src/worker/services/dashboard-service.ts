import type { PriceSource } from "../../shared/domain";
import { SettingsRepository } from "../repositories/settings-repository";

/** 仪表盘引用的单个价格快照；金额保留最小货币单位和人民币分，浏览器不能自行重算汇率或来源。 */
export interface DashboardPrice {
  amountMinor: number;
  cnyFen: number | null;
  source: PriceSource;
  capturedAt: string;
}

/**
 * 单个已监控地区的概览值。没有 current 时表示尚无可信价格，`isStale` 也必须为 false，
 * 因为“尚未采集”与“保留旧价格但最近连续失败”是管理员需要区分的两种业务状态。
 */
export interface DashboardRegion {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  current: DashboardPrice | null;
  historicalLow: DashboardPrice | null;
  isStale: boolean;
}

/** 跨区历史最低价只包含已换算人民币的快照，避免直接比较不同货币的最小单位。 */
export interface DashboardAllRegionHistoricalLow extends DashboardPrice {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  cnyFen: number;
}

/**
 * 单个订阅卡所需的稳定 DTO。停用订阅仍会返回以保留管理员恢复配置的入口，
 * 但统计和日报不应把它算作当前监控范围。
 */
export interface DashboardSubscription {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: boolean;
  regionalProductIds: string[];
  allRegionHistoricalLow: DashboardAllRegionHistoricalLow | null;
  regions: DashboardRegion[];
}

/**
 * 首页顶部统计与订阅卡集合。最后采集和下次日报都是 ISO 时间，前端只根据管理员界面需求格式化，
 * 不用浏览器时钟猜测 Worker 的采集执行时刻。
 */
export interface DashboardOverview {
  stats: {
    monitoredSubscriptionCount: number;
    availableRegionPriceCount: number;
    lastCapturedAt: string | null;
    nextDailyReportAt: string | null;
  };
  subscriptions: DashboardSubscription[];
}

/** 仪表盘订阅概览的 D1 行模型；地区商品 ID 仅用于关联当前价格与历史最低价。 */
interface DashboardRow {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: number;
  regionalProductIds: string | null;
}

/** 地区价格行同时携带最新、最低快照和采集健康状态；空快照字段不能被格式化为零价格。 */
interface DashboardRegionRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  currency: string;
  currentAmountMinor: number | null;
  currentCnyFen: number | null;
  currentSource: PriceSource | null;
  currentCapturedAt: string | null;
  lowAmountMinor: number | null;
  lowCnyFen: number | null;
  lowSource: PriceSource | null;
  lowCapturedAt: string | null;
  consecutiveFailures: number | null;
}

/** 跨区最低价行只选择 cny_fen 非空的记录，确保比较对象具有相同的人民币成本含义。 */
interface DashboardAllRegionLowRow {
  subscriptionId: string;
  regionalProductId: string;
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number;
  source: PriceSource;
  capturedAt: string;
}

/**
 * 仪表盘服务将 D1 的订阅、快照与设置读取聚合为浏览器和日报可共享的 DTO。
 * 它不读取会话、Telegram 凭据或外站响应，防止概览接口越过最小数据暴露边界。
 */
export class DashboardService {
  public constructor(private readonly database: D1Database) {}

  /**
   * 按创建顺序读取所有订阅与已选择地区。`now` 可由测试固定，生产环境默认使用 Worker 当前时间；
   * 下次日报只在已完成初始化时计算，未设置站点不能凭空承诺一个执行时间。
   */
  public async getOverview(now = new Date()): Promise<DashboardOverview> {
    const [subscriptions, regionResult, allRegionLowResult, settings] = await Promise.all([
      this.database
        .prepare(
          `SELECT subscriptions.id AS subscriptionId, subscriptions.game_id AS gameId,
                  games.name_zh AS nameZh, games.name_en AS nameEn, subscriptions.enabled AS enabled,
                  GROUP_CONCAT(subscription_regions.regional_product_id) AS regionalProductIds
           FROM subscriptions
           INNER JOIN games ON games.id = subscriptions.game_id
           LEFT JOIN subscription_regions ON subscription_regions.subscription_id = subscriptions.id
           GROUP BY subscriptions.id
           ORDER BY subscriptions.created_at ASC`,
        )
        .all<DashboardRow>(),
      // 每个地区商品在相关子查询中独立选择最新和本币最低快照；同一采集时刻以自增 ID 固定并列顺序。
      this.database
        .prepare(
          `SELECT subscription_regions.subscription_id AS subscriptionId, products.id AS regionalProductId,
                  products.region_code AS regionCode, products.currency AS currency,
                  latest.amount_minor AS currentAmountMinor, latest.cny_fen AS currentCnyFen,
                  latest.source AS currentSource, latest.captured_at AS currentCapturedAt,
                  lowest.amount_minor AS lowAmountMinor, lowest.cny_fen AS lowCnyFen,
                  lowest.source AS lowSource, lowest.captured_at AS lowCapturedAt,
                  health.consecutive_failures AS consecutiveFailures
           FROM subscription_regions
           INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
           LEFT JOIN price_snapshots AS latest ON latest.id = (
             SELECT id FROM price_snapshots WHERE regional_product_id = products.id ORDER BY captured_at DESC, id DESC LIMIT 1
           )
           LEFT JOIN price_snapshots AS lowest ON lowest.id = (
             SELECT id FROM price_snapshots WHERE regional_product_id = products.id ORDER BY amount_minor ASC, captured_at ASC, id ASC LIMIT 1
           )
           LEFT JOIN regional_product_health AS health ON health.regional_product_id = products.id
           ORDER BY subscription_regions.subscription_id ASC, products.created_at ASC, products.id ASC`,
        )
        .all<DashboardRegionRow>(),
      // 窗口函数在每个订阅内按人民币成本选择唯一最低价；无法换算人民币的快照不能参与跨区比较。
      this.database
        .prepare(
          `WITH ranked_lows AS (
             SELECT subscription_regions.subscription_id AS subscriptionId,
                    snapshots.regional_product_id AS regionalProductId,
                    products.region_code AS regionCode, snapshots.amount_minor AS amountMinor,
                    snapshots.currency AS currency, snapshots.cny_fen AS cnyFen,
                    snapshots.source AS source, snapshots.captured_at AS capturedAt,
                    ROW_NUMBER() OVER (
                      PARTITION BY subscription_regions.subscription_id
                      ORDER BY snapshots.cny_fen ASC, snapshots.captured_at ASC, snapshots.id ASC
                    ) AS priceRank
             FROM subscription_regions
             INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id
             INNER JOIN price_snapshots AS snapshots ON snapshots.regional_product_id = products.id
             WHERE snapshots.cny_fen IS NOT NULL
           )
           SELECT subscriptionId, regionalProductId, regionCode, amountMinor, currency, cnyFen, source, capturedAt
           FROM ranked_lows
           WHERE priceRank = 1`,
        )
        .all<DashboardAllRegionLowRow>(),
      new SettingsRepository(this.database).get(),
    ]);

    const regionsBySubscription = new Map<string, DashboardRegion[]>();
    for (const row of regionResult.results) {
      const regions = regionsBySubscription.get(row.subscriptionId) ?? [];
      const current = this.toPrice(row.currentAmountMinor, row.currentCnyFen, row.currentSource, row.currentCapturedAt);
      regions.push({
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        currency: row.currency,
        current,
        historicalLow: this.toPrice(row.lowAmountMinor, row.lowCnyFen, row.lowSource, row.lowCapturedAt),
        // 健康表只在采集失败后出现；有旧价格且连续失败才标为过期，避免把首次等待采集误报成来源异常。
        isStale: current !== null && (row.consecutiveFailures ?? 0) > 0,
      });
      regionsBySubscription.set(row.subscriptionId, regions);
    }

    const allRegionLowsBySubscription = new Map<string, DashboardAllRegionHistoricalLow>();
    for (const row of allRegionLowResult.results) {
      allRegionLowsBySubscription.set(row.subscriptionId, {
        regionalProductId: row.regionalProductId,
        regionCode: row.regionCode,
        amountMinor: row.amountMinor,
        currency: row.currency,
        cnyFen: row.cnyFen,
        source: row.source,
        capturedAt: row.capturedAt,
      });
    }

    const dashboardSubscriptions = subscriptions.results.map((row): DashboardSubscription => ({
      subscriptionId: row.subscriptionId,
      gameId: row.gameId,
      nameZh: row.nameZh,
      nameEn: row.nameEn,
      enabled: row.enabled === 1,
      regionalProductIds: row.regionalProductIds?.split(",") ?? [],
      allRegionHistoricalLow: allRegionLowsBySubscription.get(row.subscriptionId) ?? null,
      regions: regionsBySubscription.get(row.subscriptionId) ?? [],
    }));

    // 顶部统计仅反映仍启用的订阅；暂停项目保留在卡片列表供恢复，却不能让用户误以为仍在采集或影响日报。
    const monitoredSubscriptions = dashboardSubscriptions.filter((subscription) => subscription.enabled);
    const currentPrices = monitoredSubscriptions.flatMap((subscription) => subscription.regions.map((region) => region.current).filter((price): price is DashboardPrice => price !== null));
    const lastCapturedAt = currentPrices.reduce<string | null>((latest, price) => latest === null || price.capturedAt > latest ? price.capturedAt : latest, null);

    return {
      stats: {
        monitoredSubscriptionCount: monitoredSubscriptions.length,
        availableRegionPriceCount: currentPrices.length,
        lastCapturedAt,
        nextDailyReportAt: settings ? nextDailyReportAt(now, settings.timezone, settings.dailyReportTime) : null,
      },
      subscriptions: dashboardSubscriptions,
    };
  }

  /** 将 LEFT JOIN 的空快照列转换为 null，禁止浏览器收到无法完整解释来源和采集时间的半截价格对象。 */
  private toPrice(amountMinor: number | null, cnyFen: number | null, source: PriceSource | null, capturedAt: string | null): DashboardPrice | null {
    if (amountMinor === null || source === null || capturedAt === null) return null;
    return { amountMinor, cnyFen, source, capturedAt };
  }
}

/**
 * 计算管理员本地时区中的下一次日报分钟。逐分钟检测让 Intl 处理夏令时转换，
 * 不手写 UTC 偏移；26 小时上限覆盖一次完整本地日和 DST 的一小时跳变，异常设置则安全返回 null。
 */
function nextDailyReportAt(now: Date, timezone: string, dailyReportTime: string): string | null {
  const firstCandidate = new Date(now.getTime());
  firstCandidate.setUTCSeconds(0, 0);
  for (let offsetMinutes = 1; offsetMinutes <= 26 * 60; offsetMinutes += 1) {
    const candidate = new Date(firstCandidate.getTime() + offsetMinutes * 60_000);
    if (formatHourMinute(candidate, timezone) === dailyReportTime) return candidate.toISOString();
  }
  return null;
}

/** 从 Intl 格式部件生成固定 HH:mm，避免宿主区域格式将 09:00 显示为 9:00 而破坏设置比较。 */
function formatHourMinute(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.hour}:${fields.minute}`;
}
