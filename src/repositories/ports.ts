import type { AppSettings, SubscriptionRecord } from "../shared/domain";
import type { DashboardOverview } from "../services/dashboard-service";
import type { HistoryResult } from "../services/history-service";
import type { ProductHealthState } from "../services/price-rules";

/**
 * 设置读取端口只返回已经通过业务规则验证的公开设置。
 * SQL、JSONB 原始值和数据库连接都不得越过该边界，避免服务层绕过地区白名单或意外接触未来的敏感配置列。
 */
export interface SettingsReader {
  get(): Promise<AppSettings | null>;
}

/** 公开设置服务只需在读取端口上增加完整替换；首次认证初始化写入仍属于 Task 4 的独立事务边界。 */
export interface SettingsStore extends SettingsReader {
  save(settings: AppSettings, updatedAt: string): Promise<void>;
}

/** 按逻辑游戏读取单一订阅；返回领域记录而非 ARRAY_AGG 行或 PostgreSQL BOOLEAN，供创建前查重等业务规则复用。 */
export interface SubscriptionReader {
  findByGameId(gameId: string): Promise<SubscriptionRecord | null>;
}

/**
 * 订阅详情的单笔价格快照继续使用整数最小货币单位和人民币分。
 * `cnyFen` 可空代表当次汇率缺失，服务和浏览器都不得把它格式化为零人民币价格。
 */
export interface SubscriptionDetailPriceSnapshot {
  amountMinor: number;
  cnyFen: number | null;
  source: string;
  capturedAt: string;
}

/**
 * 一个已确认地区商品的详情读取模型。
 * `monitored=false` 仅表示当前订阅未选择它，仍允许页面展示并重新勾选；空价格与 stale 状态必须保持可区分。
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
 * 平台中立订阅详情 DTO 只包含页面展示和安全编辑所需字段。
 * 会话、恢复码、Telegram 配置、商品 URL、外部响应和数据库错误都不属于该端口。
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

/** 详情读取端口把缺失记录表示为 null，由服务统一转换为既有安全 404 业务错误。 */
export interface SubscriptionDetailReader {
  find(subscriptionId: string): Promise<SubscriptionDetail | null>;
}

/** 商品健康仓储只保存连续失败和是否已通知的最小状态；错误正文、外部响应与 Telegram 凭据永不进入该端口。 */
export interface ProductHealthStore {
  get(regionalProductId: string): Promise<ProductHealthState>;
  save(regionalProductId: string, state: ProductHealthState, lastSuccessAt: string | null, updatedAt: string): Promise<void>;
}

/** 预留通知事件只允许受控事件类型和去重键，调用方不能写消息正文、Token、Chat ID 或任意状态。 */
export interface NotificationEventReservation {
  regionalProductId: string | null;
  eventType: "collection-failure" | "collection-recovered" | "official-price-drop" | "target-price";
  dedupeKey: string;
  createdAt: string;
}

/**
 * 待发送事件仅暴露格式化和确认投递所需字段。
 * 关联主档删除后商品、游戏名和地区都允许为 null，发送器必须使用中性文案而不能泄漏内部 ID。
 */
export interface PendingNotificationEvent {
  regionalProductId: string | null;
  eventType: NotificationEventReservation["eventType"];
  dedupeKey: string;
  createdAt: string;
  gameNameZh: string | null;
  regionCode: string | null;
}

/** 通知事件仓储把唯一预留、一次性交付确认和 pending 读取限定为三个明确操作。 */
export interface NotificationEventStore {
  reserve(event: NotificationEventReservation): Promise<boolean>;
  markDelivered(dedupeKey: string, sentAt: string): Promise<boolean>;
  pending(): Promise<PendingNotificationEvent[]>;
}

/**
 * 仪表盘读取端口直接返回既有平台中立 DTO。
 * `now` 使用 ISO UTC 字符串固定测试与调度口径，仓储实现不得把 PostgreSQL 行、主键类型或查询文本泄漏给服务。
 */
export interface DashboardReader {
  getOverview(now: string): Promise<DashboardOverview>;
}

/**
 * 历史读取端口保留服务现有的响应结构，并把地区筛选作为参数传入。
 * 实现必须使用参数化查询，不能让地址栏中的订阅 ID 或地区代码参与 SQL 结构拼接。
 */
export interface HistoryReader {
  list(subscriptionId: string, region: string | null): Promise<HistoryResult>;
}

/**
 * CSV 读取端口按三种明确用途分别提供结果，禁止通用表名或列名输入。
 * 固定方法集合是认证、会话和 Telegram 字段永远不进入导出的最后一道类型边界。
 */
export interface ExportReader {
  pricesCsv(): Promise<string>;
  subscriptionsCsv(): Promise<string>;
  fetchLogsCsv(): Promise<string>;
}
