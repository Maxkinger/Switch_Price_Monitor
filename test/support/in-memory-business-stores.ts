import {
  AuthInitializationConflictError,
  AuthRecoveryRejectedError,
  type AtomicLoginAttempt,
  type AtomicLoginAttemptResult,
  type AuthRepository,
  type ExistingSubscriptionConfirmation,
  type ExistingSubscriptionRegionCompletion,
  type HashedAdminSetup,
  type LoginAttemptRecord,
  type NotificationEventReservation,
  type NotificationEventStore,
  type PendingNotificationEvent,
  type PasswordCredential,
  type PasswordResetWrite,
  type PasswordVerifier,
  type ProductHealthStore,
  type RecoveryCredential,
  type StoredSession,
  type SubscriptionConfirmationStore,
  type ValidatedConfirmedRegion,
  type ValidatedSubscriptionConfirmation,
} from "../../src/repositories/ports";
import type { ProductHealthState } from "../../src/services/price-rules";
import type { OfficialProductCandidate } from "../../src/shared/domain";

/**
 * 认证业务测试专用的内存状态。它只保存端口允许的哈希、盐和会话摘要，不保存明文密码、恢复码或 Cookie，
 * 因而测试替身不会削弱生产代码正在验证的秘密边界；每个用例必须新建实例，避免安全状态跨用例泄漏。
 */
interface InMemoryAdminState {
  passwordHash: string;
  passwordSalt: string;
  recoveryHash: string;
  recoverySalt: string;
  recoveryUsedAt: string | null;
}

/** 内存会话额外记录撤销时刻；有效性仍由摘要、过期时间和撤销状态共同决定。 */
interface InMemorySession extends StoredSession {
  revokedAt: string | null;
}

/**
 * 平台中立认证仓储替身只实现 AuthService 所依赖的领域端口。登录资格、失败计数、建会话和密码恢复按一次同步状态变更处理，
 * 用于锁定业务规则而非复刻某个数据库驱动的锁、队列或事务实现；这类实现级并发保证由 PostgreSQL 集成测试负责。
 */
export class InMemoryAuthStore implements AuthRepository {
  private admin: InMemoryAdminState | null = null;
  private loginAttempt: LoginAttemptRecord | null = null;
  private readonly sessions = new Map<string, InMemorySession>();

  public async isInitialized(): Promise<boolean> {
    return this.admin !== null;
  }

  public async initialize(input: HashedAdminSetup): Promise<void> {
    // 单管理员初始化只能成功一次；替身抛出与真实适配器相同的受控冲突，避免测试依赖数据库错误文本。
    if (this.admin !== null) throw new AuthInitializationConflictError();
    this.admin = {
      passwordHash: input.passwordHash,
      passwordSalt: input.passwordSalt,
      recoveryHash: input.recoveryHash,
      recoverySalt: input.recoverySalt,
      recoveryUsedAt: null,
    };
  }

  public async getLoginAttempt(): Promise<LoginAttemptRecord | null> {
    return this.loginAttempt === null ? null : { ...this.loginAttempt };
  }

  public async getPasswordCredential(): Promise<PasswordCredential | null> {
    return this.admin === null
      ? null
      : { passwordHash: this.admin.passwordHash, passwordSalt: this.admin.passwordSalt };
  }

  public async createSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.tokenHash, { ...session, revokedAt: null });
  }

  public async performLoginAttempt(
    input: AtomicLoginAttempt,
    verifyPassword: PasswordVerifier,
  ): Promise<AtomicLoginAttemptResult> {
    const nowMs = Date.parse(input.now);
    const thresholdMs = Date.parse(input.lockedUntilOnThreshold);
    // 端口契约要求有效 ISO 时刻；测试替身对无效值直接失败，不能让 NaN 比较把损坏状态静默解释为已解锁。
    if (!Number.isFinite(nowMs) || !Number.isFinite(thresholdMs)) {
      throw new Error("认证测试替身只接受有效的登录与锁定时刻");
    }
    if (this.loginAttempt?.lockedUntil) {
      const lockedUntilMs = Date.parse(this.loginAttempt.lockedUntil);
      if (!Number.isFinite(lockedUntilMs)) throw new Error("认证测试替身检测到无效的既有锁定时刻");
      // 锁定截止时刻是开区间：未到期直接拒绝；到点后必须清空旧失败数，从新的五次窗口重新计数。
      if (lockedUntilMs > nowMs) return "locked";
      this.loginAttempt = null;
    }

    const valid = await verifyPassword(await this.getPasswordCredential());
    if (valid) {
      await this.createSession(input.session);
      this.loginAttempt = null;
      return "succeeded";
    }

    const failedCount = (this.loginAttempt?.failedCount ?? 0) + 1;
    this.loginAttempt = {
      failedCount,
      lockedUntil: failedCount >= input.maximumFailedLogins ? input.lockedUntilOnThreshold : null,
    };
    return "invalid";
  }

  public async getRecoveryCredential(): Promise<RecoveryCredential | null> {
    return this.admin === null
      ? null
      : {
          recoveryHash: this.admin.recoveryHash,
          recoverySalt: this.admin.recoverySalt,
          recoveryUsedAt: this.admin.recoveryUsedAt,
        };
  }

  public async resetPassword(input: PasswordResetWrite): Promise<void> {
    // 恢复码摘要必须仍与读取时一致且尚未消费；失败统一抛受控信号，不能泄漏具体恢复状态。
    if (this.admin === null || this.admin.recoveryUsedAt !== null || this.admin.recoveryHash !== input.recoveryHash) {
      throw new AuthRecoveryRejectedError();
    }
    this.admin.passwordHash = input.passwordHash;
    this.admin.passwordSalt = input.passwordSalt;
    this.admin.recoveryUsedAt = input.recoveryUsedAt;
    this.loginAttempt = null;
    for (const session of this.sessions.values()) session.revokedAt = input.sessionRevokedAt;
  }

  public async revokeSession(tokenHash: string, now: string): Promise<void> {
    // 未知摘要保持幂等，防止退出接口变成会话枚举渠道。
    const session = this.sessions.get(tokenHash);
    if (session !== undefined && session.revokedAt === null) session.revokedAt = now;
  }

  public async isSessionValid(tokenHash: string, now: string): Promise<boolean> {
    const session = this.sessions.get(tokenHash);
    return session !== undefined && session.revokedAt === null && Date.parse(session.expiresAt) > Date.parse(now);
  }

  public async clearLoginAttempt(): Promise<void> {
    this.loginAttempt = null;
  }
}

/** 健康状态替身保留端口状态外加最近成功时间；该时间只允许成功采集更新，失败轮必须沿用旧值。 */
interface StoredProductHealth extends ProductHealthState {
  lastSuccessAt: string | null;
  updatedAt: string;
}

/**
 * 采集健康业务测试专用内存端口。缺失商品按零失败、未通知状态读取，保存时复制输入，
 * 防止调用方后续修改同一对象而绕过一次 record 调用的状态边界。
 */
export class InMemoryProductHealthStore implements ProductHealthStore {
  private readonly states = new Map<string, StoredProductHealth>();

  public async get(regionalProductId: string): Promise<ProductHealthState> {
    const stored = this.states.get(regionalProductId);
    return stored === undefined
      ? { consecutiveFailures: 0, failureNotified: false }
      : { consecutiveFailures: stored.consecutiveFailures, failureNotified: stored.failureNotified };
  }

  public async save(
    regionalProductId: string,
    state: ProductHealthState,
    lastSuccessAt: string | null,
    updatedAt: string,
  ): Promise<void> {
    this.states.set(regionalProductId, {
      consecutiveFailures: state.consecutiveFailures,
      failureNotified: state.failureNotified,
      // 失败轮传入 null 的语义是“不改变最近成功”，而不是擦除曾经成功的时间。
      lastSuccessAt: lastSuccessAt ?? this.states.get(regionalProductId)?.lastSuccessAt ?? null,
      updatedAt,
    });
  }

  /** 只向断言返回副本，测试不能借此直接篡改下一轮业务输入。 */
  public inspect(regionalProductId: string): StoredProductHealth | null {
    const stored = this.states.get(regionalProductId);
    return stored === undefined ? null : { ...stored };
  }
}

/** 内存通知记录在端口 DTO 外只增加投递状态；消息正文和 Telegram 凭据不属于本测试边界。 */
export interface InspectedNotificationEvent extends NotificationEventReservation {
  status: "pending" | "delivered";
  sentAt: string | null;
}

/**
 * 通知预留替身以 dedupeKey 为唯一键，重复预留返回 false 且不覆盖原事件。
 * 这锁定服务所依赖的去重契约，同时把真实唯一约束与并发争用留给 PostgreSQL 集成测试。
 */
export class InMemoryNotificationEventStore implements NotificationEventStore {
  private readonly events = new Map<string, InspectedNotificationEvent>();

  public async reserve(event: NotificationEventReservation): Promise<boolean> {
    if (this.events.has(event.dedupeKey)) return false;
    this.events.set(event.dedupeKey, { ...event, status: "pending", sentAt: null });
    return true;
  }

  public async markDelivered(dedupeKey: string, sentAt: string): Promise<boolean> {
    const event = this.events.get(dedupeKey);
    if (event === undefined || event.status !== "pending") return false;
    event.status = "delivered";
    event.sentAt = sentAt;
    return true;
  }

  public async pending(): Promise<PendingNotificationEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.status === "pending")
      .map((event) => ({
        regionalProductId: event.regionalProductId,
        eventType: event.eventType,
        dedupeKey: event.dedupeKey,
        createdAt: event.createdAt,
        gameNameZh: null,
        regionCode: null,
      }));
  }

  /** 事件按插入顺序返回副本，使第三次失败与恢复的先后关系可直接验证。 */
  public inspectAll(): InspectedNotificationEvent[] {
    return [...this.events.values()].map((event) => ({ ...event }));
  }
}

/**
 * 一个已确认订阅的内存投影。`historySnapshotCount` 与 `globalTargetCnyFen` 是补全端口不可写的既有业务哨兵，
 * 用于证明服务只追加地区；它们不模拟价格表或目标价表，真实跨表事务仍由 PostgreSQL 集成测试承担。
 */
interface StoredConfirmation {
  confirmation: ValidatedSubscriptionConfirmation;
  anchor: OfficialProductCandidate;
  historySnapshotCount: number;
  globalTargetCnyFen: number | null;
}

/** 供用例构造既有订阅；所有字段均是公开业务 DTO 或不变量哨兵，不包含数据库行与驱动句柄。 */
export interface ExistingConfirmationSeed {
  confirmation: ValidatedSubscriptionConfirmation;
  anchor: OfficialProductCandidate;
  historySnapshotCount?: number;
  globalTargetCnyFen?: number | null;
}

/**
 * 最终确认与地区补全共享的平台中立端口替身。它保存服务提交的已验证 DTO，并在整批预检查通过后一次加入内存状态；
 * 测试由此断言“失败前零写入”和“已有订阅不被替换”等服务边界，数据库原子性、锁和唯一约束由 PostgreSQL 专项测试验证。
 */
export class InMemorySubscriptionConfirmationStore implements SubscriptionConfirmationStore {
  private readonly recordsBySubscriptionId = new Map<string, StoredConfirmation>();

  public seedExisting(seed: ExistingConfirmationSeed): void {
    // 夹具也必须满足唯一订阅与规范化名称约束，避免无效测试数据制造生产环境不可能出现的状态。
    if (this.recordsBySubscriptionId.has(seed.confirmation.subscriptionId)) {
      throw new Error("测试夹具包含重复订阅 ID");
    }
    if (this.findStoredByNormalizedName(seed.confirmation.game.normalizedName) !== null) {
      throw new Error("测试夹具包含重复规范化游戏名");
    }
    this.recordsBySubscriptionId.set(seed.confirmation.subscriptionId, {
      confirmation: cloneConfirmation(seed.confirmation),
      anchor: { ...seed.anchor },
      historySnapshotCount: seed.historySnapshotCount ?? 0,
      globalTargetCnyFen: seed.globalTargetCnyFen ?? null,
    });
  }

  public async findExistingByNormalizedNames(
    normalizedNames: string[],
  ): Promise<Map<string, ExistingSubscriptionConfirmation>> {
    const result = new Map<string, ExistingSubscriptionConfirmation>();
    for (const normalizedName of normalizedNames) {
      const stored = this.findStoredByNormalizedName(normalizedName);
      if (stored !== null) {
        result.set(normalizedName, {
          normalizedName,
          gameId: stored.confirmation.game.id,
          subscriptionId: stored.confirmation.subscriptionId,
        });
      }
    }
    return result;
  }

  public async createAtomically(inputs: ValidatedSubscriptionConfirmation[], _now: string): Promise<void> {
    // 先验证整批 ID、规范化名称与地区，再统一提交，防止后一个无效输入留下前一个半成品；这是替身的端口语义而非数据库事务模拟。
    const pendingSubscriptionIds = new Set<string>();
    const pendingNormalizedNames = new Set<string>();
    for (const input of inputs) {
      if (this.recordsBySubscriptionId.has(input.subscriptionId) || pendingSubscriptionIds.has(input.subscriptionId)) {
        throw new Error("确认批次包含重复订阅 ID");
      }
      if (this.findStoredByNormalizedName(input.game.normalizedName) !== null || pendingNormalizedNames.has(input.game.normalizedName)) {
        throw new Error("确认批次包含重复规范化游戏名");
      }
      if (new Set(input.regions.map((region) => region.regionCode)).size !== input.regions.length) {
        throw new Error("确认批次包含重复地区");
      }
      if (input.regions[0] === undefined) {
        throw new Error("确认批次缺少官方锚点地区");
      }
      pendingSubscriptionIds.add(input.subscriptionId);
      pendingNormalizedNames.add(input.game.normalizedName);
    }

    for (const input of inputs) {
      // 上一轮已对整批证明非空；这里的非空断言只向 TypeScript 传递同一事实，不在提交阶段新增可失败分支。
      const firstRegion = input.regions[0];
      if (firstRegion === undefined) throw new Error("确认批次预检与提交状态不一致");
      this.recordsBySubscriptionId.set(input.subscriptionId, {
        confirmation: cloneConfirmation(input),
        // 新建确认用例不会在同一测试内再执行地区补全；仍构造最小锚点以保持记录结构完整，不将价格写入身份判断。
        anchor: {
          regionCode: firstRegion.regionCode,
          productUrl: firstRegion.productUrl,
          canonicalTitle: input.game.nameEn,
          publisher: input.game.publisher,
          productType: input.game.productType,
          currency: firstRegion.currency,
          coverUrl: input.game.coverUrl,
          currentPriceMinor: null,
          regularPriceMinor: null,
        },
        historySnapshotCount: 0,
        globalTargetCnyFen: null,
      });
    }
  }

  public async findForRegionCompletion(
    subscriptionId: string,
  ): Promise<ExistingSubscriptionRegionCompletion | null> {
    const stored = this.recordsBySubscriptionId.get(subscriptionId);
    if (stored === undefined) return null;
    return {
      subscriptionId,
      gameId: stored.confirmation.game.id,
      anchor: { ...stored.anchor },
      existingRegionCodes: stored.confirmation.regions.map((region) => region.regionCode),
    };
  }

  public async completeAtomically(
    subscriptionId: string,
    gameId: string,
    regions: ValidatedConfirmedRegion[],
    _now: string,
  ): Promise<void> {
    const stored = this.recordsBySubscriptionId.get(subscriptionId);
    if (stored === undefined || stored.confirmation.game.id !== gameId) throw new Error("订阅补全目标不存在");
    const occupied = new Set(stored.confirmation.regions.map((region) => region.regionCode));
    if (regions.some((region) => occupied.has(region.regionCode)) || new Set(regions.map((region) => region.regionCode)).size !== regions.length) {
      throw new Error("订阅补全包含重复地区");
    }
    // 只有地区 DTO 被追加；历史快照计数、目标价、游戏和订阅 ID 均保持原值。
    stored.confirmation.regions.push(...regions.map((region) => ({ ...region })));
  }

  /** 返回与四张核心业务表相同的逻辑计数，断言只依赖领域实体数量而不依赖 SQL 列名。 */
  public counts(): { games: number; products: number; subscriptions: number; regions: number } {
    const records = [...this.recordsBySubscriptionId.values()];
    const regionalCount = records.reduce((total, record) => total + record.confirmation.regions.length, 0);
    return { games: records.length, products: regionalCount, subscriptions: records.length, regions: regionalCount };
  }

  /** 中文展示名与官方英文身份来自服务提交 DTO；返回副本避免断言修改持久状态。 */
  public firstGameNames(): { nameZh: string; nameEn: string } | null {
    const first = this.recordsBySubscriptionId.values().next().value as StoredConfirmation | undefined;
    return first === undefined ? null : { nameZh: first.confirmation.game.nameZh, nameEn: first.confirmation.game.nameEn };
  }

  /** 只读取某订阅已绑定的地区商品 ID，用于确认幂等命中不会偷偷补区或替换原关联。 */
  public regionIds(subscriptionId: string): string[] {
    return [...(this.recordsBySubscriptionId.get(subscriptionId)?.confirmation.regions ?? [])]
      .map((region) => region.id)
      .sort();
  }

  /** 地区代码排序后返回，便于补全测试验证只追加缺失地区。 */
  public regionCodes(subscriptionId: string): string[] {
    return [...(this.recordsBySubscriptionId.get(subscriptionId)?.confirmation.regions ?? [])]
      .map((region) => region.regionCode)
      .sort();
  }

  /** 返回补全端口无权修改的历史与目标价哨兵，确保测试继续锁定“不覆盖既有监控配置”的规则。 */
  public protectedState(subscriptionId: string): { historySnapshotCount: number; globalTargetCnyFen: number | null } | null {
    const stored = this.recordsBySubscriptionId.get(subscriptionId);
    return stored === undefined
      ? null
      : { historySnapshotCount: stored.historySnapshotCount, globalTargetCnyFen: stored.globalTargetCnyFen };
  }

  private findStoredByNormalizedName(normalizedName: string): StoredConfirmation | null {
    return [...this.recordsBySubscriptionId.values()].find(
      (record) => record.confirmation.game.normalizedName === normalizedName,
    ) ?? null;
  }
}

/** 深复制地区数组，阻止服务返回后或测试夹具持有者从外部修改内存端口状态。 */
function cloneConfirmation(input: ValidatedSubscriptionConfirmation): ValidatedSubscriptionConfirmation {
  return {
    game: { ...input.game },
    subscriptionId: input.subscriptionId,
    regions: input.regions.map((region) => ({ ...region })),
  };
}
