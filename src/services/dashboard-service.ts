import type { DashboardReader } from "../repositories/ports";
import type { PriceSource } from "../shared/domain";

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
 * 首页顶部统计与订阅卡集合。最后采集和下次日报都是 ISO 时间，前端使用同时返回的管理员时区格式化，
 * 不用浏览器时钟猜测服务端采集执行时刻或日报口径。
 */
export interface DashboardOverview {
  stats: {
    monitoredSubscriptionCount: number;
    availableRegionPriceCount: number;
    lastCapturedAt: string | null;
    /** 只公开已验证的 IANA 时区，供前端把 UTC 传输值转成与日报设置一致的可读时间。 */
    timezone: string | null;
    nextDailyReportAt: string | null;
  };
  subscriptions: DashboardSubscription[];
}

/** 仪表盘统计只需设置中的时区和日报分钟，完整设置或未来秘密列不得传入聚合规则。 */
export interface DashboardScheduleSettings {
  timezone: string;
  dailyReportTime: string;
}

/**
 * 仪表盘服务只依赖返回既有 DTO 的读取端口。
 * PostgreSQL、D1、SQL 文本和数据库行都停留在适配器内，路由与日报继续复用同一公开业务结果。
 */
export class DashboardService {
  public constructor(private readonly reader: DashboardReader) {}

  /** 默认使用服务端当前时间；测试可固定 Date，传给仓储时统一为 UTC ISO 字符串。 */
  public async getOverview(now = new Date()): Promise<DashboardOverview> {
    return this.reader.getOverview(now.toISOString());
  }
}

/**
 * 从已经完成 SQL 行转换的订阅 DTO 计算顶部统计和下次日报。
 * 停用订阅保留卡片但不计数；无 current 的地区不计可用价格，也不能影响最后成功采集时间。
 */
export function buildDashboardOverview(
  subscriptions: DashboardSubscription[],
  settings: DashboardScheduleSettings | null,
  now: string,
): DashboardOverview {
  const monitoredSubscriptions = subscriptions.filter((subscription) => subscription.enabled);
  const currentPrices = monitoredSubscriptions.flatMap((subscription) => (
    subscription.regions
      .map((region) => region.current)
      .filter((price): price is DashboardPrice => price !== null)
  ));
  const lastCapturedAt = currentPrices.reduce<string | null>(
    (latest, price) => latest === null || price.capturedAt > latest ? price.capturedAt : latest,
    null,
  );

  return {
    stats: {
      monitoredSubscriptionCount: monitoredSubscriptions.length,
      availableRegionPriceCount: currentPrices.length,
      lastCapturedAt,
      // 设置尚未初始化时不得伪造时区或日报；受认证页面会在初始化完成后得到已校验值。
      timezone: settings?.timezone ?? null,
      nextDailyReportAt: settings ? nextDailyReportAt(new Date(now), settings.timezone, settings.dailyReportTime) : null,
    },
    subscriptions,
  };
}

/**
 * 计算管理员本地时区中的下一次日报分钟。逐分钟检测让 Intl 处理夏令时转换，
 * 不手写 UTC 偏移；26 小时上限覆盖一次完整本地日和 DST 的一小时跳变，异常设置则安全返回 null。
 */
function nextDailyReportAt(now: Date, timezone: string, dailyReportTime: string): string | null {
  if (Number.isNaN(now.getTime())) return null;
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
