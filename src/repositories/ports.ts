import type { RateResult, RegionalProduct } from "../providers/types";
import type { AppSettings, HistoricalLow, SubscriptionRecord } from "../shared/domain";
import type { DashboardOverview } from "../services/dashboard-service";
import type { ProductHealthState } from "../services/price-rules";
import type { SubscriptionDetail } from "./subscription-detail-repository";
import type {
  NotificationEventReservation,
  PendingNotificationEvent,
} from "./notification-event-repository";

/**
 * PostgreSQL 迁移期间供服务层使用的窄仓储端口。
 * 这些接口只暴露消费者实际需要的领域 DTO，不包含 pg 类型、SQL、数据库行或 D1 API，
 * 以便 Node 与临时 Worker 兼容装配共享同一业务服务而不共享持久化细节。
 */
export interface SettingsReader {
  get(): Promise<AppSettings | null>;
}

/** 定时采集只能读取当前仍启用且已由管理员确认的地区商品。 */
export interface CollectionReader {
  enabledRegionalProducts(): Promise<RegionalProduct[]>;
}

/** 价格读取端口保留计数、最近官方价与本地区历史最低价三项现有业务能力。 */
export interface PriceReader {
  countForRegionalProduct(regionalProductId: string): Promise<number>;
  latestOfficialFor(regionalProductId: string): Promise<{ amountMinor: number; source: "official" } | null>;
  lowestForRegionalProduct(regionalProductId: string): Promise<HistoricalLow | null>;
}

/** 汇率读取只允许按币种取得最近成功记录，过期判断仍由服务层决定。 */
export interface ExchangeRateReader {
  latestFor(currency: string): Promise<RateResult | null>;
}

/** 保留任务只能按服务层计算出的受控 UTC 截止点删除，不能接受任意 SQL。 */
export interface RetentionStore {
  deletePriceSnapshotsBefore(cutoff: string): Promise<number>;
  deleteFetchLogsBefore(cutoff: string): Promise<number>;
}

/**
 * Task 3 只迁移订阅查询能力；创建、目标价、地区替换与永久删除事务由 Task 4 接管。
 * 空地区数组是合法查询输入并返回 false，避免生成 PostgreSQL 的非法空 IN 条件。
 */
export interface SubscriptionReader {
  hasEnabledProductsForGame(gameId: string, regionalProductIds: string[]): Promise<boolean>;
  gameIdForSubscription(id: string): Promise<string | null>;
  findByGameId(gameId: string): Promise<SubscriptionRecord | null>;
}

/** 详情服务只读取一个已经脱敏的订阅 DTO，缺失语义由服务转换为业务 404。 */
export interface SubscriptionDetailReader {
  find(subscriptionId: string): Promise<SubscriptionDetail | null>;
}

/** 健康状态端口不暴露日志正文或通知凭据，只保存失败去重所需的最小状态。 */
export interface ProductHealthStore {
  get(regionalProductId: string): Promise<ProductHealthState>;
  save(
    regionalProductId: string,
    state: ProductHealthState,
    lastSuccessAt: string | null,
    updatedAt: string,
  ): Promise<void>;
}

/** 通知事件端口保留数据库唯一键预留、成功确认与待发送读取三项能力。 */
export interface NotificationEventStore {
  reserve(event: NotificationEventReservation): Promise<boolean>;
  markDelivered(dedupeKey: string, sentAt: string): Promise<boolean>;
  pending(): Promise<PendingNotificationEvent[]>;
}

/** 仪表盘仓储返回既有平台中立 DTO；服务只负责稳定的公共调用边界。 */
export interface DashboardReader {
  getOverview(now?: Date): Promise<DashboardOverview>;
}

/** 历史行只包含曲线展示所需字段，内部 BIGINT 主键和认证数据均不可见。 */
export interface HistorySnapshot {
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number | null;
  source: string;
  capturedAt: string;
}

/** 历史查询端口由仓储执行参数化地区筛选，并保持确定的时间顺序。 */
export interface HistoryReader {
  list(subscriptionId: string, region: string | null): Promise<{ snapshots: HistorySnapshot[] }>;
}

/** 三种 CSV 的数据库行分别固定白名单，未来认证或 Telegram 列不能因 SELECT * 被带入导出。 */
export interface PriceExportRow extends HistorySnapshot {}
export interface SubscriptionExportRow {
  subscriptionId: string;
  gameId: string;
  enabled: boolean;
  regionCode: string | null;
  regionalProductId: string | null;
}
export interface FetchLogExportRow {
  regionCode: string | null;
  source: string;
  status: string;
  message: string | null;
  capturedAt: string;
}

/** CSV 服务只读取三组安全行；引号转义和列头业务仍留在服务层。 */
export interface ExportReader {
  prices(): Promise<PriceExportRow[]>;
  subscriptions(): Promise<SubscriptionExportRow[]>;
  fetchLogs(): Promise<FetchLogExportRow[]>;
}
