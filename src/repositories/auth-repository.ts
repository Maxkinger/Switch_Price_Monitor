import type {
  AtomicLoginAttempt,
  AtomicLoginAttemptResult,
  AuthRepository,
  HashedAdminSetup,
  LoginAttemptRecord,
  PasswordCredential,
  PasswordVerifier,
  PasswordResetWrite,
  RecoveryCredential,
  StoredSession,
} from "./ports";
import {
  AuthInitializationConflictError,
  AuthRecoveryRejectedError,
} from "./ports";

/**
 * D1 兼容入口按数据库绑定维护 isolate 内认证队列，避免同一 Worker 实例的登录与密码恢复步骤互相穿插。
 * 正式 Node 运行时由 PostgreSQL 事务行锁提供跨进程严格保证；此队列仅维持迁移期 D1 单 isolate 语义。
 */
const d1AuthQueues = new WeakMap<object, Promise<void>>();

/**
 * Worker 兼容期的 D1 认证适配器。业务服务只依赖 AuthRepository，此类集中保留旧平台 SQL，
 * 供 Task 4 的 Worker 入口显式装配；Node/PostgreSQL 运行时不会引用 D1 类型或 batch 语义。
 */
export class D1AuthRepository implements AuthRepository {
  public constructor(private readonly database: D1Database) {}

  public async isInitialized(): Promise<boolean> {
    return Boolean(
      await this.database.prepare("SELECT id FROM admin_credentials WHERE id = 1").first(),
    );
  }

  public async initialize(input: HashedAdminSetup): Promise<void> {
    try {
      // 凭据与设置必须处在同一个 D1 原子批次，兼容入口也不能保留旧版分两次提交的部分初始化风险。
      await this.database.batch([
        this.database
          .prepare(
            `INSERT INTO admin_credentials (
               id, password_hash, password_salt, recovery_hash, recovery_salt, created_at
             ) VALUES (1, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.passwordHash,
            input.passwordSalt,
            input.recoveryHash,
            input.recoverySalt,
            input.createdAt,
          ),
        this.database
          .prepare(
            `INSERT INTO settings (
               id, enabled_regions_json, default_search_region, created_at, updated_at
             ) VALUES (1, ?, ?, ?, ?)`,
          )
          .bind(
            JSON.stringify(input.initialSettings.enabledRegions),
            input.initialSettings.defaultSearchRegion,
            input.createdAt,
            input.createdAt,
          ),
      ]);
    } catch (error) {
      // D1 不提供与 pg SQLSTATE 等价的稳定类型；初始化前检查后的失败只在已出现单管理员时收窄为受控竞争冲突。
      if (await this.isInitialized()) throw new AuthInitializationConflictError();
      throw error;
    }
  }

  public async getLoginAttempt(): Promise<LoginAttemptRecord | null> {
    return this.database
      .prepare(
        `SELECT failed_count AS failedCount,
                locked_until AS lockedUntil
           FROM login_attempts
          WHERE id = 1`,
      )
      .first<LoginAttemptRecord>();
  }

  public async getPasswordCredential(): Promise<PasswordCredential | null> {
    return this.database
      .prepare(
        `SELECT password_hash AS passwordHash,
                password_salt AS passwordSalt
           FROM admin_credentials
          WHERE id = 1`,
      )
      .first<PasswordCredential>();
  }

  public async createSession(session: StoredSession): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO sessions (id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(session.id, session.tokenHash, session.expiresAt, session.createdAt)
      .run();
  }

  public async performLoginAttempt(
    input: AtomicLoginAttempt,
    verifyPassword: PasswordVerifier,
  ): Promise<AtomicLoginAttemptResult> {
    return serializeD1AuthOperation(this.database, async () => {
      const attempt = await this.getLoginAttempt();
      const nowMs = Date.parse(input.now);
      const lockedUntilMs = attempt?.lockedUntil
        ? Date.parse(attempt.lockedUntil)
        : null;
      // 活跃锁定在读取密码凭据前结束，确保兼容入口同样不会为已无资格的请求执行 PBKDF2。
      if (lockedUntilMs !== null && lockedUntilMs > nowMs) return "locked";

      // 自然到期的锁定开启新窗口；没有锁定时继续累加当前失败次数。
      const failedCount = lockedUntilMs === null
        ? (attempt?.failedCount ?? 0)
        : 0;
      const passwordMatches = await verifyPassword(
        await this.getPasswordCredential(),
      );
      if (!passwordMatches) {
        const nextFailedCount = failedCount + 1;
        const nextLockedUntil =
          nextFailedCount >= input.maximumFailedLogins
            ? input.lockedUntilOnThreshold
            : null;
        /**
         * isolate 队列保证这里写入的是本队列的串行下一状态；显式覆盖值也让到期后的首次失败重置为一。
         * D1 多 isolate 不具备此进程内保证，迁移目标 PostgreSQL 的 FOR UPDATE 才是生产严格边界。
         */
        await this.database
          .prepare(
            `INSERT INTO login_attempts (id, failed_count, locked_until)
             VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE
                   SET failed_count = excluded.failed_count,
                       locked_until = excluded.locked_until`,
          )
          .bind(nextFailedCount, nextLockedUntil)
          .run();
        return "invalid";
      }

      /**
       * D1 batch 把成功后的失败状态清理和会话摘要创建绑定为原子提交；
       * 会话写入失败时不能先清空限流状态，队列也会在异常后释放给后续请求。
       */
      await this.database.batch([
        this.database.prepare("DELETE FROM login_attempts WHERE id = 1"),
        this.database
          .prepare(
            `INSERT INTO sessions (id, token_hash, expires_at, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(
            input.session.id,
            input.session.tokenHash,
            input.session.expiresAt,
            input.session.createdAt,
          ),
      ]);
      return "succeeded";
    });
  }

  public async getRecoveryCredential(): Promise<RecoveryCredential | null> {
    return this.database
      .prepare(
        `SELECT recovery_hash AS recoveryHash,
                recovery_salt AS recoverySalt,
                recovery_used_at AS recoveryUsedAt
           FROM admin_credentials
          WHERE id = 1`,
      )
      .first<RecoveryCredential>();
  }

  public async resetPassword(input: PasswordResetWrite): Promise<void> {
    return serializeD1AuthOperation(
      this.database,
      () => this.resetPasswordWithoutQueue(input),
    );
  }

  /**
   * 原始恢复写只允许由同一 binding 认证队列调用，不能再次入队，否则当前操作等待自身尾节点会永久阻塞。
   * 登录先完成建会话或失败计数后，排在其后的恢复 batch 才更新密码并撤销包含新会话在内的全部活动会话。
   */
  private async resetPasswordWithoutQueue(
    input: PasswordResetWrite,
  ): Promise<void> {
    /**
     * 首条 UPDATE 在原子批次内同时比较摘要和未消费状态；后续语句额外绑定本次新密码摘要，
     * 因而竞争失败方即使与成功方时间相同，也不能撤销会话或清理失败记录。
     */
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE admin_credentials
              SET password_hash = ?,
                  password_salt = ?,
                  recovery_used_at = ?
            WHERE id = 1
              AND recovery_used_at IS NULL
              AND recovery_hash = ?`,
        )
        .bind(
          input.passwordHash,
          input.passwordSalt,
          input.recoveryUsedAt,
          input.recoveryHash,
        ),
      this.database
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE revoked_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM admin_credentials
                 WHERE id = 1
                   AND password_hash = ?
                   AND recovery_hash = ?
                   AND recovery_used_at = ?
              )`,
        )
        .bind(
          input.sessionRevokedAt,
          input.passwordHash,
          input.recoveryHash,
          input.recoveryUsedAt,
        ),
      this.database
        .prepare(
          `DELETE FROM login_attempts
            WHERE id = 1
              AND EXISTS (
                SELECT 1
                  FROM admin_credentials
                 WHERE id = 1
                   AND password_hash = ?
                   AND recovery_hash = ?
                   AND recovery_used_at = ?
              )`,
        )
        .bind(input.passwordHash, input.recoveryHash, input.recoveryUsedAt),
    ]);
    if (results[0]?.meta.changes !== 1) throw new AuthRecoveryRejectedError();
  }

  public async revokeSession(tokenHash: string, now: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE sessions
            SET revoked_at = ?
          WHERE token_hash = ?
            AND revoked_at IS NULL`,
      )
      .bind(now, tokenHash)
      .run();
  }

  public async isSessionValid(tokenHash: string, now: string): Promise<boolean> {
    return Boolean(
      await this.database
        .prepare(
          `SELECT id
             FROM sessions
            WHERE token_hash = ?
              AND revoked_at IS NULL
              AND expires_at > ?`,
        )
        .bind(tokenHash, now)
        .first(),
    );
  }

  public async clearLoginAttempt(): Promise<void> {
    await this.database.prepare("DELETE FROM login_attempts WHERE id = 1").run();
  }
}

/**
 * 同一 D1 绑定的登录与密码恢复按进入顺序逐个执行。队尾 Promise 只承担释放信号且永不继承业务异常，
 * 因此一次数据库、PBKDF2 或条件恢复失败不会永久阻塞后续认证；空闲时删除键避免长期保留绑定引用。
 */
async function serializeD1AuthOperation<T>(
  database: D1Database,
  operation: () => Promise<T>,
): Promise<T> {
  const key = database as object;
  const previous = d1AuthQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  d1AuthQueues.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (d1AuthQueues.get(key) === current) d1AuthQueues.delete(key);
  }
}
