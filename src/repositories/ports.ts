import type { ProductType } from "../providers/types";
import type {
  AppSettings,
  InitialSettings,
  OfficialProductCandidate,
  RegionalProductMatchSource,
  RegionCode,
  SubscriptionInput,
  SubscriptionRecord,
} from "../shared/domain";
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

/** 浏览器只能提交公开设置的局部补丁；createdAt 与未来秘密字段永远不能由 PATCH 覆盖。 */
export type SettingsPatch = Partial<Omit<AppSettings, "createdAt">>;

/**
 * 公开设置写入必须接收局部补丁而非服务读出的完整快照。
 * PostgreSQL 实现会在同一行锁事务内重读、合并、校验和写入，避免两个管理员请求修改不同字段时发生丢失更新或破坏默认区从属关系。
 */
export interface SettingsStore extends SettingsReader {
  save(patch: SettingsPatch, updatedAt: string): Promise<AppSettings | null>;
}

/** 首次管理员设置只保存派生后的秘密材料；明文密码和恢复码不得越过认证服务进入仓储。 */
export interface HashedAdminSetup {
  passwordHash: string;
  passwordSalt: string;
  recoveryHash: string;
  recoverySalt: string;
  createdAt: string;
  initialSettings: Omit<InitialSettings, "createdAt">;
}

/** 会话写入模型只包含随机 ID、原始令牌摘要和服务端时间，原始 Cookie 令牌永不进入数据库接口。 */
export interface StoredSession {
  id: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

/** 单管理员失败状态使用绝对 UTC 解锁时间；null 表示尚未达到连续五次阈值。 */
export interface LoginAttemptRecord {
  failedCount: number;
  lockedUntil: string | null;
}

/** 密码验证只读取 PBKDF2 输出和盐，仓储不得返回恢复码或会话信息扩大敏感面。 */
export interface PasswordCredential {
  passwordHash: string;
  passwordSalt: string;
}

/** 恢复验证附带一次性消费时刻；非空时服务必须使用统一无效文案拒绝重放。 */
export interface RecoveryCredential {
  recoveryHash: string;
  recoverySalt: string;
  recoveryUsedAt: string | null;
}

/** 密码恢复事务同时更换派生材料、消费恢复状态并用同一时刻撤销所有会话。 */
export interface PasswordResetWrite {
  passwordHash: string;
  passwordSalt: string;
  recoveryUsedAt: string;
  sessionRevokedAt: string;
}

/**
 * 原子失败计数由服务提供阈值与本次绝对解锁时间，仓储只负责并发安全地递增并在阈值封顶。
 * 这样 PBKDF2、五次阈值和十五分钟规则仍属于认证服务，而 PostgreSQL 不会因读改写竞态丢失失败次数。
 */
export interface FailedLoginWrite {
  now: string;
  lockedUntil: string;
  maximumFailedLogins: number;
}

/**
 * 条件建立会话携带服务刚刚验证过的凭据版本。
 * 仓储必须在同一事务内锁定管理员行、确认哈希与盐未变化、检查锁定状态、清空失败记录并插入摘要会话。
 */
export interface SessionEstablishmentWrite {
  expectedCredential: PasswordCredential;
  session: StoredSession;
  now: string;
}

/** 会话事务只返回安全分类，服务据此沿用既有密码错误或锁定文案，绝不接触 pg 错误或连接对象。 */
export type SessionEstablishment = "created" | "credential-changed" | "locked";

/** 并发首次初始化命中单例约束时使用内部错误，认证服务会把它转换成既有 ALREADY_INITIALIZED 安全响应。 */
export class AuthInitializationConflictError extends Error {}

/** 并发恢复只有一个事务可消费恢复状态；失败方统一转换为“恢复码无效或已使用”，不能暴露竞争顺序。 */
export class AuthRecoveryAlreadyUsedError extends Error {}

/**
 * 平台中立认证仓储保留 brief 的基础读写，并增加两个闭合并发安全缺口的原子操作。
 * 所有多语句实现必须在仓储内部使用同一事务 executor；AuthService 永远不能取得 PoolClient、SQL 或事务句柄。
 */
export interface AuthRepository {
  isInitialized(): Promise<boolean>;
  initialize(input: HashedAdminSetup): Promise<void>;
  getLoginAttempt(): Promise<LoginAttemptRecord | null>;
  getPasswordCredential(): Promise<PasswordCredential | null>;
  createSession(session: StoredSession): Promise<void>;
  establishSession(input: SessionEstablishmentWrite): Promise<SessionEstablishment>;
  recordFailedLogin(input: FailedLoginWrite): Promise<LoginAttemptRecord>;
  getRecoveryCredential(): Promise<RecoveryCredential | null>;
  resetPassword(input: PasswordResetWrite): Promise<void>;
  revokeSession(tokenHash: string, now: string): Promise<void>;
  isSessionValid(tokenHash: string, now: string): Promise<boolean>;
  saveLoginAttempt(input: LoginAttemptRecord): Promise<void>;
  clearLoginAttempt(): Promise<void>;
}

/** 按逻辑游戏读取单一订阅；返回领域记录而非 ARRAY_AGG 行或 PostgreSQL BOOLEAN，供创建前查重等业务规则复用。 */
export interface SubscriptionReader {
  findByGameId(gameId: string): Promise<SubscriptionRecord | null>;
}

/** 普通订阅创建事务的三种结果；商品归属错误只返回分类，由服务转换为稳定中文领域错误。 */
export type AtomicSubscriptionCreationResult =
  | { status: "created"; subscriptionId: string }
  | { status: "existing"; subscriptionId: string }
  | { status: "product-mismatch" };

/** 地区替换在同一事务内重读订阅归属并验证商品，避免检查后并发删除或跨游戏关系形成半更新。 */
export type AtomicRegionalProductReplacementResult = "updated" | "not-found" | "product-mismatch";

/**
 * 普通订阅写端口把查重、商品归属、主记录与关系写入收进仓储事务。
 * 目标价、地区替换和永久删除同样不得由服务拼接多个独立查询，否则故障会留下影响采集和通知的半配置。
 */
export interface SubscriptionStore extends SubscriptionReader {
  createOrOpenAtomically(input: SubscriptionInput): Promise<AtomicSubscriptionCreationResult>;
  hasEnabledProductsForGame(gameId: string, regionalProductIds: string[]): Promise<boolean>;
  create(input: SubscriptionInput): Promise<void>;
  setEnabled(id: string, enabled: boolean, updatedAt: string): Promise<boolean>;
  setTargets(id: string, globalTargetCnyFen: number | null, regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>, updatedAt: string): Promise<boolean>;
  gameIdForSubscription(id: string): Promise<string | null>;
  replaceRegionalProductsAtomically(id: string, regionalProductIds: string[], updatedAt: string): Promise<AtomicRegionalProductReplacementResult>;
  replaceRegionalProducts(id: string, regionalProductIds: string[], updatedAt: string): Promise<void>;
  deleteMany(subscriptionIds: string[]): Promise<boolean>;
}

/** 已有订阅只返回确认服务决定幂等结果所需的标识，不能让新建流程覆盖管理员既有地区范围。 */
export interface ExistingSubscriptionConfirmation {
  normalizedName: string;
  gameId: string;
  subscriptionId: string;
}

/** 经官方页面和本区价格 ID 重新验证后的单区写入模型；浏览器候选原文不得直接进入仓储。 */
export interface ValidatedConfirmedRegion {
  id: string;
  regionCode: RegionCode;
  currency: string;
  officialPriceId: string | null;
  productUrl: string;
  matchSource: RegionalProductMatchSource;
}

/** 一条新确认订阅的完整原子数据；所有业务主键均由服务端生成。 */
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

/** 已有订阅补全锚点只来自持久化关系；旧价格被有意排除，保存前仍须重新访问任天堂官方来源。 */
export interface ExistingSubscriptionRegionCompletion {
  subscriptionId: string;
  gameId: string;
  anchor: OfficialProductCandidate;
  existingRegionCodes: RegionCode[];
}

/** 确认与补全共享的窄仓储端口；外部官方网络验证必须在进入这些短事务之前完成。 */
export interface SubscriptionConfirmationStore {
  findExistingByNormalizedNames(normalizedNames: string[]): Promise<Map<string, ExistingSubscriptionConfirmation>>;
  createAtomically(inputs: ValidatedSubscriptionConfirmation[], now: string): Promise<void>;
  findForRegionCompletion(subscriptionId: string): Promise<ExistingSubscriptionRegionCompletion | null>;
  completeAtomically(subscriptionId: string, gameId: string, regions: ValidatedConfirmedRegion[], now: string): Promise<void>;
}

/** 手动刷新只保留最近请求时刻，不保存管理员、会话、商品、价格响应或排队状态。 */
export interface ManualRefreshRequestResult {
  accepted: boolean;
  requestedAt: string;
  nextAllowedAt: string;
}

/** 单语句刷新写端口不把采集器包入数据库事务，避免外部来源耗时长期占用连接。 */
export interface ManualRefreshStore {
  request(now: string): Promise<ManualRefreshRequestResult>;
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
