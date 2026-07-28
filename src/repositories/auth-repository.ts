import type {
  AuthRepository,
  HashedAdminSetup,
  LoginAttemptRecord,
  PasswordCredential,
  PasswordResetWrite,
  RecoveryCredential,
  StoredSession,
} from "./ports";
import { AuthInitializationConflictError } from "./ports";

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
    // D1 兼容适配器仍以单批次保证密码、恢复码、会话和失败记录共同提交。
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE admin_credentials
              SET password_hash = ?,
                  password_salt = ?,
                  recovery_used_at = ?
            WHERE id = 1`,
        )
        .bind(input.passwordHash, input.passwordSalt, input.recoveryUsedAt),
      this.database
        .prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL")
        .bind(input.sessionRevokedAt),
      this.database.prepare("DELETE FROM login_attempts WHERE id = 1"),
    ]);
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

  public async saveLoginAttempt(input: LoginAttemptRecord): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO login_attempts (id, failed_count, locked_until)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE
               SET failed_count = excluded.failed_count,
                   locked_until = excluded.locked_until`,
      )
      .bind(input.failedCount, input.lockedUntil)
      .run();
  }

  public async clearLoginAttempt(): Promise<void> {
    await this.database.prepare("DELETE FROM login_attempts WHERE id = 1").run();
  }
}
