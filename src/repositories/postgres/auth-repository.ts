import type { AppDatabase, SqlExecutor } from "../../server/database/types";
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

/** PostgreSQL TIMESTAMPTZ 默认解码为 Date；所有认证时间在离开仓储前统一恢复为 UTC ISO 字符串。 */
interface LoginAttemptRow {
  failedCount: number;
  lockedUntil: Date | string | null;
}

/** 密码与恢复材料只使用显式列别名，禁止 SELECT * 将未来认证字段意外带入服务。 */
interface PasswordCredentialRow {
  passwordHash: string;
  passwordSalt: string;
}

/** 恢复状态行不包含密码或会话摘要，服务仅能验证本次一次性恢复码。 */
interface RecoveryCredentialRow {
  recoveryHash: string;
  recoverySalt: string;
  recoveryUsedAt: Date | string | null;
}

/** 会话建立事务只需读取当前锁定时刻；失败次数本身不会暴露给浏览器。 */
interface SessionLockRow {
  lockedUntil: Date | string | null;
}

/**
 * PostgreSQL 单管理员认证仓储。
 * PBKDF2、随机恢复码、Cookie 原始令牌和安全错误文案仍归 AuthService；本类只保存派生材料，并用同连接事务闭合初始化、恢复与会话竞态。
 */
export class AuthRepository implements AuthRepositoryPort {
  public constructor(private readonly database: AppDatabase) {}

  /** 公开状态只判断固定单例是否存在，不读取任何哈希、盐、恢复状态或会话事实。 */
  public async isInitialized(): Promise<boolean> {
    const result = await this.database.query<{ initialized: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM admin_credentials WHERE id = 1) AS initialized",
    );
    return result.rows[0]?.initialized === true;
  }

  /**
   * 凭据与首次地区设置使用同一个事务 executor。
   * 并发初始化只有一个事务能插入 id=1；任何单例冲突都抛内部分类并回滚另一张表，禁止出现“能登录但没有设置”的半初始化状态。
   */
  public async initialize(input: HashedAdminSetup): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const credentials = await transaction.query(
        `INSERT INTO admin_credentials (
           id, password_hash, password_salt, recovery_hash, recovery_salt, created_at
         ) VALUES (1, $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [input.passwordHash, input.passwordSalt, input.recoveryHash, input.recoverySalt, input.createdAt],
      );
      if (credentials.rowCount !== 1) throw new AuthInitializationConflictError("管理员已经初始化。");

      const settings = await transaction.query(
        `INSERT INTO settings (
           id, enabled_regions_json, default_search_region, created_at, updated_at
         ) VALUES (1, $1::jsonb, $2, $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(input.initialSettings.enabledRegions), input.initialSettings.defaultSearchRegion, input.createdAt],
      );
      if (settings.rowCount !== 1) throw new AuthInitializationConflictError("管理员设置已经初始化。");
    });
  }

  /** 失败记录不存在表示从零开始；locked_until 始终返回 UTC ISO，避免 NAS 本地时区改变锁定判断。 */
  public async getLoginAttempt(): Promise<LoginAttemptRecord | null> {
    const result = await this.database.query<LoginAttemptRow>(
      `SELECT failed_count AS "failedCount", locked_until AS "lockedUntil"
         FROM login_attempts
        WHERE id = 1`,
    );
    return result.rows[0] ? mapLoginAttempt(result.rows[0]) : null;
  }

  /** 密码验证只读取既有 PBKDF2 十六进制文本与盐，不能返回恢复码或管理员初始化时间。 */
  public async getPasswordCredential(): Promise<PasswordCredential | null> {
    const result = await this.database.query<PasswordCredentialRow>(
      `SELECT password_hash AS "passwordHash", password_salt AS "passwordSalt"
         FROM admin_credentials
        WHERE id = 1`,
    );
    return result.rows[0] ?? null;
  }

  /** 基础会话写方法保留 brief 契约；正常登录使用 establishSession，避免先清锁定后插入失败或跨密码恢复逃逸。 */
  public async createSession(session: StoredSession): Promise<void> {
    await insertSession(this.database, session);
  }

  /**
   * 条件会话建立先锁定管理员凭据，再检查锁定记录并在同一事务清理失败状态、插入令牌摘要。
   * 若密码恢复先提交，哈希或盐已变化，旧密码即使在事务外完成 PBKDF2 也只能得到 credential-changed；若登录先提交，随后恢复会撤销这条会话。
   */
  public async establishSession(input: SessionEstablishmentWrite): Promise<SessionEstablishment> {
    return this.database.transaction(async (transaction) => {
      const credentialResult = await transaction.query<PasswordCredentialRow>(
        `SELECT password_hash AS "passwordHash", password_salt AS "passwordSalt"
           FROM admin_credentials
          WHERE id = 1
          FOR UPDATE`,
      );
      const current = credentialResult.rows[0];
      if (
        !current
        || current.passwordHash !== input.expectedCredential.passwordHash
        || current.passwordSalt !== input.expectedCredential.passwordSalt
      ) {
        return "credential-changed";
      }

      const attemptResult = await transaction.query<SessionLockRow>(
        `SELECT locked_until AS "lockedUntil"
           FROM login_attempts
          WHERE id = 1
          FOR UPDATE`,
      );
      const lockedUntil = attemptResult.rows[0]?.lockedUntil;
      if (lockedUntil !== undefined && lockedUntil !== null && Date.parse(toIsoString(lockedUntil, "登录锁定时间无效。")) > Date.parse(input.now)) {
        return "locked";
      }

      // 清理与 INSERT 同事务：会话唯一约束或连接故障会恢复旧失败状态，不能把一次未成功登录当作已认证清零。
      await transaction.query("DELETE FROM login_attempts WHERE id = 1");
      await insertSession(transaction, input.session);
      return "created";
    });
  }

  /**
   * 单条 UPSERT 在数据库行锁下递增失败次数，避免多个 Node 进程同时读到相同旧值后互相覆盖。
   * 活跃锁定保持原计数与解锁时间；自然到期后从 1 重新累计；达到阈值时计数封顶并写服务提供的绝对 UTC 解锁时间。
   */
  public async recordFailedLogin(input: FailedLoginWrite): Promise<LoginAttemptRecord> {
    const result = await this.database.query<LoginAttemptRow>(
      `INSERT INTO login_attempts (id, failed_count, locked_until)
       VALUES (1, 1, CASE WHEN 1 >= $3 THEN $2::timestamptz ELSE NULL END)
       ON CONFLICT (id) DO UPDATE
       SET failed_count = CASE
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > $1::timestamptz
               THEN login_attempts.failed_count
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= $1::timestamptz
               THEN 1
             ELSE LEAST(login_attempts.failed_count + 1, $3)
           END,
           locked_until = CASE
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until > $1::timestamptz
               THEN login_attempts.locked_until
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= $1::timestamptz
               THEN CASE WHEN 1 >= $3 THEN $2::timestamptz ELSE NULL END
             WHEN login_attempts.failed_count + 1 >= $3
               THEN $2::timestamptz
             ELSE NULL
           END
       RETURNING failed_count AS "failedCount", locked_until AS "lockedUntil"`,
      [input.now, input.lockedUntil, input.maximumFailedLogins],
    );
    const row = result.rows[0];
    if (!row) throw new Error("登录失败状态未能保存。");
    return mapLoginAttempt(row);
  }

  /** 恢复验证只读取哈希、盐和是否已消费；恢复码明文只在 AuthService 当前调用中短暂存在。 */
  public async getRecoveryCredential(): Promise<RecoveryCredential | null> {
    const result = await this.database.query<RecoveryCredentialRow>(
      `SELECT recovery_hash AS "recoveryHash",
              recovery_salt AS "recoverySalt",
              recovery_used_at AS "recoveryUsedAt"
         FROM admin_credentials
        WHERE id = 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      recoveryHash: row.recoveryHash,
      recoverySalt: row.recoverySalt,
      recoveryUsedAt: row.recoveryUsedAt === null ? null : toIsoString(row.recoveryUsedAt, "恢复码使用时间无效。"),
    };
  }

  /**
   * 密码、恢复码消费、全部会话撤销和失败记录清理共享一个事务。
   * 条件 UPDATE 同时锁定管理员行；并发恢复只有首个事务能修改 recovery_used_at，失败方不会清锁定或重复撤销后伪装成功。
   */
  public async resetPassword(input: PasswordResetWrite): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE admin_credentials
            SET password_hash = $1, password_salt = $2, recovery_used_at = $3
          WHERE id = 1 AND recovery_used_at IS NULL`,
        [input.passwordHash, input.passwordSalt, input.recoveryUsedAt],
      );
      if (updated.rowCount !== 1) throw new AuthRecoveryAlreadyUsedError("恢复状态已被消费。");

      await transaction.query(
        "UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL",
        [input.sessionRevokedAt],
      );
      await transaction.query("DELETE FROM login_attempts WHERE id = 1");
    });
  }

  /** 退出只撤销当前摘要且保持幂等；不存在的 tokenHash 不返回会话存在性信号。 */
  public async revokeSession(tokenHash: string, now: string): Promise<void> {
    await this.database.query(
      "UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL",
      [now, tokenHash],
    );
  }

  /** 会话有效性同时要求摘要匹配、未撤销和严格晚于当前时刻，原始 Cookie 不会进入 SQL。 */
  public async isSessionValid(tokenHash: string, now: string): Promise<boolean> {
    const result = await this.database.query<{ valid: boolean }>(
      `SELECT EXISTS(
         SELECT 1
           FROM sessions
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > $2::timestamptz
       ) AS valid`,
      [tokenHash, now],
    );
    return result.rows[0]?.valid === true;
  }

  /** 基础覆盖写方法保留 brief 契约；认证服务正常失败路径使用 recordFailedLogin 的原子递增。 */
  public async saveLoginAttempt(input: LoginAttemptRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO login_attempts (id, failed_count, locked_until)
       VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE
       SET failed_count = EXCLUDED.failed_count, locked_until = EXCLUDED.locked_until`,
      [input.failedCount, input.lockedUntil],
    );
  }

  /** 成功认证、密码恢复和锁定自然到期均删除单例记录，使下一次失败从零开始。 */
  public async clearLoginAttempt(): Promise<void> {
    await this.database.query("DELETE FROM login_attempts WHERE id = 1");
  }
}

/** 所有会话 INSERT 都使用调用方提供的 executor，事务路径绝不能退回连接池导致密码恢复无法回滚或撤销。 */
async function insertSession(executor: SqlExecutor, session: StoredSession): Promise<void> {
  await executor.query(
    "INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)",
    [session.id, session.tokenHash, session.expiresAt, session.createdAt],
  );
}

/** 把 pg Date 或测试字符串统一为现有领域使用的 UTC ISO，拒绝无效时间而不是让锁定安全规则产生 NaN。 */
function toIsoString(value: Date | string, errorMessage: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(errorMessage);
  return date.toISOString();
}

/** 登录失败行转换集中处理 nullable TIMESTAMPTZ，避免不同方法对同一锁定时刻产生不同格式。 */
function mapLoginAttempt(row: LoginAttemptRow): LoginAttemptRecord {
  return {
    failedCount: row.failedCount,
    lockedUntil: row.lockedUntil === null ? null : toIsoString(row.lockedUntil, "登录锁定时间无效。"),
  };
}
