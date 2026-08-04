import type {
  AuthRepository as AuthRepositoryPort,
  FailedLoginWrite,
  HashedAdminSetup,
  LoginAttemptRecord,
  PasswordCredential,
  PasswordResetWrite,
  RecoveryCredential,
  SessionEstablishment,
  SessionEstablishmentWrite,
  StoredSession,
} from "../ports";
import {
  AuthInitializationConflictError,
  AuthRecoveryAlreadyUsedError,
} from "../ports";

/** D1 过渡适配器内部仍使用 TEXT 时间；ISO UTC 字符串按字典序即可保持锁定与过期比较顺序。 */
interface LoginAttemptRow {
  failedCount: number;
  lockedUntil: string | null;
}

/**
 * Task 5 移除 Worker 前的 D1 认证兼容仓储。
 * 它让 AuthService 与路由先完成平台中立迁移；NAS 生产装配只会使用 PostgreSQL 实现，D1 类型不会重新进入服务或路由。
 */
export class AuthRepository implements AuthRepositoryPort {
  public constructor(private readonly database: D1Database) {}

  /** 状态端点只检查固定单例，不返回任何密码、恢复码、会话或设置字段。 */
  public async isInitialized(): Promise<boolean> {
    return Boolean(await this.database.prepare("SELECT id FROM admin_credentials WHERE id = 1").first());
  }

  /**
   * D1 batch 保持过渡 Worker 的首次凭据与设置原子性。
   * 并发单例冲突统一收窄为内部分类；真实 SQL 文案不会越过 AuthService 进入公开响应。
   */
  public async initialize(input: HashedAdminSetup): Promise<void> {
    try {
      await this.database.batch([
        this.database
          .prepare("INSERT INTO admin_credentials (id, password_hash, password_salt, recovery_hash, recovery_salt, created_at) VALUES (1, ?, ?, ?, ?, ?)")
          .bind(input.passwordHash, input.passwordSalt, input.recoveryHash, input.recoverySalt, input.createdAt),
        this.database
          .prepare("INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at) VALUES (1, ?, ?, ?, ?)")
          .bind(JSON.stringify(input.initialSettings.enabledRegions), input.initialSettings.defaultSearchRegion, input.createdAt, input.createdAt),
      ]);
    } catch (error) {
      // 仅在数据库已经存在单例时转换为安全冲突；其它存储故障继续交给路由统一脱敏为 500。
      if (await this.isInitialized()) throw new AuthInitializationConflictError("管理员已经初始化。");
      throw error;
    }
  }

  /** 读取失败次数和绝对解锁时刻，缺失记录表示尚未发生失败。 */
  public async getLoginAttempt(): Promise<LoginAttemptRecord | null> {
    return this.database
      .prepare("SELECT failed_count AS failedCount, locked_until AS lockedUntil FROM login_attempts WHERE id = 1")
      .first<LoginAttemptRow>();
  }

  /** 只读取 PBKDF2 材料，恢复码与会话摘要不进入密码校验调用。 */
  public async getPasswordCredential(): Promise<PasswordCredential | null> {
    return this.database
      .prepare("SELECT password_hash AS passwordHash, password_salt AS passwordSalt FROM admin_credentials WHERE id = 1")
      .first<PasswordCredential>();
  }

  /** 基础写方法供 brief 契约兼容；正常登录使用带凭据条件的 establishSession。 */
  public async createSession(session: StoredSession): Promise<void> {
    await this.database
      .prepare("INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(session.id, session.tokenHash, session.expiresAt, session.createdAt)
      .run();
  }

  /**
   * 条件 INSERT 先重新比较服务刚验证的哈希与盐并拒绝锁定账户，随后 DELETE 仅以该新会话 ID 为条件执行。
   * 若密码恢复先提交，旧凭据 INSERT 为零行且绝不能清除新密码生命周期的失败计数；若会话先提交，恢复 batch 会撤销它。
   */
  public async establishSession(input: SessionEstablishmentWrite): Promise<SessionEstablishment> {
    const results = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO sessions (id, token_hash, expires_at, created_at)
           SELECT ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM admin_credentials
             WHERE id = 1 AND password_hash = ? AND password_salt = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM login_attempts
             WHERE id = 1 AND locked_until IS NOT NULL AND locked_until > ?
           )`,
        )
        .bind(
          input.session.id,
          input.session.tokenHash,
          input.session.expiresAt,
          input.session.createdAt,
          input.expectedCredential.passwordHash,
          input.expectedCredential.passwordSalt,
          input.now,
        ),
      this.database
        .prepare(
          `DELETE FROM login_attempts
            WHERE id = 1
              AND (locked_until IS NULL OR locked_until <= ?)
              AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND token_hash = ?)`,
        )
        .bind(input.now, input.session.id, input.session.tokenHash),
    ]);
    if (results[0]?.meta.changes === 1) return "created";

    const current = await this.getPasswordCredential();
    if (
      !current
      || current.passwordHash !== input.expectedCredential.passwordHash
      || current.passwordSalt !== input.expectedCredential.passwordSalt
    ) {
      return "credential-changed";
    }
    const attempt = await this.getLoginAttempt();
    return attempt?.lockedUntil && Date.parse(attempt.lockedUntil) > Date.parse(input.now) ? "locked" : "credential-changed";
  }

  /**
   * SQLite UPSERT 在单条语句内串行化失败计数；活跃锁不延长，过期锁从一重新累计，达到阈值后封顶。
   * 该过渡实现保持与 PostgreSQL 相同的五次/十五分钟服务规则，避免 Worker 回归测试依赖旧读改写竞态。
   */
  public async recordFailedLogin(input: FailedLoginWrite): Promise<LoginAttemptRecord> {
    const row = await this.database
      .prepare(
        `INSERT INTO login_attempts (id, failed_count, locked_until)
         VALUES (1, 1, CASE WHEN 1 >= ? THEN ? ELSE NULL END)
         ON CONFLICT(id) DO UPDATE SET
           failed_count = CASE
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?
               THEN login_attempts.failed_count
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= ?
               THEN 1
             ELSE MIN(login_attempts.failed_count + 1, ?)
           END,
           locked_until = CASE
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > ?
               THEN login_attempts.locked_until
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= ?
               THEN CASE WHEN 1 >= ? THEN ? ELSE NULL END
             WHEN login_attempts.failed_count + 1 >= ?
               THEN ?
             ELSE NULL
           END
         RETURNING failed_count AS failedCount, locked_until AS lockedUntil`,
      )
      .bind(
        input.maximumFailedLogins,
        input.lockedUntil,
        input.now,
        input.now,
        input.maximumFailedLogins,
        input.now,
        input.now,
        input.maximumFailedLogins,
        input.lockedUntil,
        input.maximumFailedLogins,
        input.lockedUntil,
      )
      .first<LoginAttemptRow>();
    if (!row) throw new Error("登录失败状态未能保存。");
    return row;
  }

  /** 恢复读取不返回密码材料或会话信息，恢复码明文始终只存在于服务调用栈。 */
  public async getRecoveryCredential(): Promise<RecoveryCredential | null> {
    return this.database
      .prepare("SELECT recovery_hash AS recoveryHash, recovery_salt AS recoverySalt, recovery_used_at AS recoveryUsedAt FROM admin_credentials WHERE id = 1")
      .first<RecoveryCredential>();
  }

  /**
   * D1 batch 原子完成密码更换、恢复消费、全会话撤销与失败状态清理。
   * 后两条语句必须匹配本次刚写入的哈希、盐和消费时刻；条件 UPDATE 为零行的并发第二次恢复只能返回安全无效分类，不能撤销随后建立的新会话或清除新的失败计数。
   */
  public async resetPassword(input: PasswordResetWrite): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare("UPDATE admin_credentials SET password_hash = ?, password_salt = ?, recovery_used_at = ? WHERE id = 1 AND recovery_used_at IS NULL")
        .bind(input.passwordHash, input.passwordSalt, input.recoveryUsedAt),
      this.database
        .prepare(
          `UPDATE sessions SET revoked_at = ?
            WHERE revoked_at IS NULL
              AND EXISTS (
                SELECT 1 FROM admin_credentials
                 WHERE id = 1 AND password_hash = ? AND password_salt = ? AND recovery_used_at = ?
              )`,
        )
        .bind(input.sessionRevokedAt, input.passwordHash, input.passwordSalt, input.recoveryUsedAt),
      this.database
        .prepare(
          `DELETE FROM login_attempts
            WHERE id = 1
              AND EXISTS (
                SELECT 1 FROM admin_credentials
                 WHERE id = 1 AND password_hash = ? AND password_salt = ? AND recovery_used_at = ?
              )`,
        )
        .bind(input.passwordHash, input.passwordSalt, input.recoveryUsedAt),
    ]);
    if (results[0]?.meta.changes !== 1) throw new AuthRecoveryAlreadyUsedError("恢复状态已被消费。");
  }

  /** 当前浏览器退出只更新匹配摘要，缺失或已撤销会话保持幂等成功。 */
  public async revokeSession(tokenHash: string, now: string): Promise<void> {
    await this.database
      .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(now, tokenHash)
      .run();
  }

  /** 原始 Cookie 先由服务做 SHA-256；仓储只比较摘要、撤销状态和严格过期边界。 */
  public async isSessionValid(tokenHash: string, now: string): Promise<boolean> {
    return Boolean(await this.database
      .prepare("SELECT id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
      .bind(tokenHash, now)
      .first());
  }

  /** 基础覆盖写保留 brief 能力；认证服务正常失败路径使用 recordFailedLogin 原子递增。 */
  public async saveLoginAttempt(input: LoginAttemptRecord): Promise<void> {
    await this.database
      .prepare("INSERT INTO login_attempts (id, failed_count, locked_until) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET failed_count = excluded.failed_count, locked_until = excluded.locked_until")
      .bind(input.failedCount, input.lockedUntil)
      .run();
  }

  /** 成功会话和密码恢复都清除单例失败状态，下一次错误从零开始。 */
  public async clearLoginAttempt(): Promise<void> {
    await this.database.prepare("DELETE FROM login_attempts WHERE id = 1").run();
  }
}
