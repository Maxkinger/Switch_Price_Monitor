import type { DashboardReader } from "../repositories/ports";
import type { PriceSource } from "../shared/domain";

/** 仪表盘引用的单个价格快照；金额保留最小货币单位和人民币分，浏览器不能自行重算汇率或来源。 */
export interface DashboardPrice {
  amountMinor: number;
  cnyFen: number | null;
  source: PriceSource;
  capturedAt: string;
}

/** 单地区当前价与最低价允许为空；没有当前价时不得把首次等待采集误标为过期。 */
export interface DashboardRegion {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  current: DashboardPrice | null;
  historicalLow: DashboardPrice | null;
  isStale: boolean;
}

/** 跨区最低价只允许 cnyFen 非空，使不同货币始终按同一人民币成本口径比较。 */
export interface DashboardAllRegionHistoricalLow extends DashboardPrice {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  cnyFen: number;
}

/** 停用订阅仍返回供恢复，但不会计入当前监控统计或日报。 */
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

/** 现有平台中立仪表盘 DTO；时间均为 UTC ISO，timezone 只用于前端按管理员日报口径显示。 */
export interface DashboardOverview {
  stats: {
    monitoredSubscriptionCount: number;
    availableRegionPriceCount: number;
    lastCapturedAt: string | null;
    timezone: string | null;
    nextDailyReportAt: string | null;
  };
  subscriptions: DashboardSubscription[];
}

/**
 * 仪表盘服务只依赖返回平台中立 DTO 的窄 reader。
 * SQL、pg 行、驱动 API 与敏感列白名单均留在仓储实现，服务保持现有公共方法供路由和日报调用。
 */
export class DashboardService {
  public constructor(private readonly dashboard: DashboardReader) {}

  public getOverview(now = new Date()): Promise<DashboardOverview> {
    return this.dashboard.getOverview(now);
  }
}
