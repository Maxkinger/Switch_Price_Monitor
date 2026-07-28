import type { RateResult, RegionalProduct } from "../providers/types";
import type {
  AppSettings,
  HistoricalLow,
  InitialSettings,
  SubscriptionInput,
  SubscriptionRecord,
} from "../shared/domain";
import type {
  ExistingSubscriptionConfirmation,
  ExistingSubscriptionRegionCompletion,
  ValidatedConfirmedRegion,
  ValidatedSubscriptionConfirmation,
} from "./subscription-confirmation-repository";
import type { ManualRefreshRequestResult } from "./manual-refresh-repository";
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

/**
 * 设置写端口只允许完整替换已验证的公开偏好；单例 ID、认证列和未来 Telegram 秘密均不由服务传入。
 * Node/PostgreSQL 与迁移期 D1 适配器可共享 SettingsService，而无需把数据库类型带入业务层。
 */
export interface SettingsStore extends SettingsReader {
  save(settings: AppSettings, updatedAt: string): Promise<void>;
}

/**
 * 首次初始化在服务层完成 PBKDF2 派生后才进入仓储；端口只接收哈希、随机盐和受控设置，
 * 从而不让数据库适配器接触管理员明文密码或一次性恢复码。
 */
export interface HashedAdminSetup {
  passwordHash: string;
  passwordSalt: string;
  recoveryHash: string;
  recoverySalt: string;
  createdAt: string;
  initialSettings: Omit<InitialSettings, "createdAt">;
}

/**
 * 会话端口只持久化随机令牌的 SHA-256 摘要。原始 Cookie 令牌不得跨过服务边界，
 * `expiresAt` 与 `createdAt` 使用 ISO 时间，由 PostgreSQL 仓储写入 TIMESTAMPTZ。
 */
export interface StoredSession {
  id: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

/** 单管理员失败记录只包含限流决策所需字段，不保存尝试密码、来源 IP 或会话材料。 */
export interface LoginAttemptRecord {
  failedCount: number;
  lockedUntil: string | null;
}

/** 密码校验端口只返回派生哈希与盐；仓储不能返回恢复状态或其他无关认证列。 */
export interface PasswordCredential {
  passwordHash: string;
  passwordSalt: string;
}

/** 恢复校验端口包含一次性消费时间，服务据此统一拒绝错误、缺失或已经使用的恢复码。 */
export interface RecoveryCredential {
  recoveryHash: string;
  recoverySalt: string;
  recoveryUsedAt: string | null;
}

/**
 * 密码恢复写入把新密码派生值、恢复码消费时间和全会话撤销时间绑定为同一业务命令。
 * 登录失败记录由仓储在同一事务中清除，防止部分提交留下旧会话或旧锁定状态。
 */
export interface PasswordResetWrite {
  passwordHash: string;
  passwordSalt: string;
  recoveryHash: string;
  recoveryUsedAt: string;
  sessionRevokedAt: string;
}

/**
 * 一次完整登录尝试携带安全策略和预生成的会话摘要，不携带明文密码。
 * 仓储必须先原子取得本次尝试资格，再调用密码校验回调；达到阈值后的并发请求不得执行昂贵校验。
 */
export interface AtomicLoginAttempt {
  now: string;
  maximumFailedLogins: number;
  lockedUntilOnThreshold: string;
  session: StoredSession;
}

/**
 * 仓储只返回三种稳定领域结果：成功已原子建会话、密码无效已计数、当前锁定未校验。
 * 驱动错误不得伪装为认证失败，必须继续抛出并由 API 的未知错误路径安全处理。
 */
export type AtomicLoginAttemptResult = "succeeded" | "invalid" | "locked";

/**
 * 密码校验回调由服务实现 PBKDF2，仓储只能提供最小派生凭据。
 * PostgreSQL 实现会在持有单管理员失败状态行锁期间调用它，以消除“检查后再校验”的并发窗口。
 */
export type PasswordVerifier = (
  credential: PasswordCredential | null,
) => Promise<boolean>;

/**
 * 平台中立认证端口把安全规则留在 AuthService，只暴露最小认证状态和原子写命令。
 * 实现不得泄漏 pg 客户端、SQL 结果或 D1 API；初始化与密码恢复必须各自在单一事务中完成。
 */
export interface AuthRepository {
  isInitialized(): Promise<boolean>;
  initialize(input: HashedAdminSetup): Promise<void>;
  getLoginAttempt(): Promise<LoginAttemptRecord | null>;
  getPasswordCredential(): Promise<PasswordCredential | null>;
  createSession(session: StoredSession): Promise<void>;
  performLoginAttempt(
    input: AtomicLoginAttempt,
    verifyPassword: PasswordVerifier,
  ): Promise<AtomicLoginAttemptResult>;
  getRecoveryCredential(): Promise<RecoveryCredential | null>;
  resetPassword(input: PasswordResetWrite): Promise<void>;
  revokeSession(tokenHash: string, now: string): Promise<void>;
  isSessionValid(tokenHash: string, now: string): Promise<boolean>;
  clearLoginAttempt(): Promise<void>;
}

/**
 * 数据库唯一约束检测到并发首次初始化时，仓储只抛出受控领域无关冲突，
 * AuthService 再映射为既有安全错误，避免把 PostgreSQL 表名、SQLSTATE 或参数带到 API。
 */
export class AuthInitializationConflictError extends Error {
  public constructor() {
    super("认证初始化已存在");
  }
}

/**
 * 恢复码在事务内条件消费失败时只抛出受控信号；服务统一转换为 InvalidRecoveryCodeError，
 * 从而不区分恢复码错误、已使用或并发竞争失败，也不泄漏数据库影响行数。
 */
export class AuthRecoveryRejectedError extends Error {
  public constructor() {
    super("认证恢复条件未满足");
  }
}

/** 手动刷新只持久化最近请求时刻；临时无冷却规则仍由既有结果 DTO 明确表达。 */
export interface ManualRefreshRequestStore {
  request(now: string): Promise<ManualRefreshRequestResult>;
}

/**
 * 订阅确认写端口覆盖规范化身份查询、新建原子批次和已有订阅地区补全。
 * 服务只依赖这些领域 DTO，不接触 D1 batch、PostgreSQL transaction 或任何驱动客户端。
 */
export interface SubscriptionConfirmationStore {
  findExistingByNormalizedNames(
    normalizedNames: string[],
  ): Promise<Map<string, ExistingSubscriptionConfirmation>>;
  createAtomically(inputs: ValidatedSubscriptionConfirmation[], now: string): Promise<void>;
  findForRegionCompletion(
    subscriptionId: string,
  ): Promise<ExistingSubscriptionRegionCompletion | null>;
  completeAtomically(
    subscriptionId: string,
    gameId: string,
    regions: ValidatedConfirmedRegion[],
    now: string,
  ): Promise<void>;
}

/**
 * 订阅编辑端口把创建、目标价、地区替换与永久删除定义为平台中立能力。
 * 需要多条 SQL 的实现必须自行提供真实事务，服务层不模拟批处理或持有数据库连接。
 */
export interface SubscriptionStore extends SubscriptionReader {
  create(input: SubscriptionInput): Promise<void>;
  setEnabled(id: string, enabled: boolean, updatedAt: string): Promise<boolean>;
  setTargets(
    id: string,
    globalTargetCnyFen: number | null,
    regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>,
    updatedAt: string,
  ): Promise<boolean>;
  replaceRegionalProducts(
    id: string,
    regionalProductIds: string[],
    updatedAt: string,
  ): Promise<void>;
  deleteMany(subscriptionIds: string[]): Promise<boolean>;
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
