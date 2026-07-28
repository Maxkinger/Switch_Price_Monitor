import type { AppDatabase, SqlExecutor } from "../../server/database/types";
import type {
  AuthRepository,
  HashedAdminSetup,
  LoginAttemptRecord,
  PasswordCredential,
  PasswordResetWrite,
  RecoveryCredential,
  StoredSession,
} from "../ports";
import { AuthInitializationConflictError } from "../ports";

/** PostgreSQL 驱动把 TIMESTAMPTZ 解码为 Date；认证服务只能接收稳定、平台中立的 ISO 时间。 */
interface LoginAttemptRow {
  failedCount: number;
  lockedUntil: Date | null;
}

/** 密码查询显式限定两列，禁止恢复码派生值因 SELECT * 意外进入普通登录路径。 */
interface PasswordCredentialRow {
  passwordHash: string;
  passwordSalt: string;
}

/** 恢复查询只包含一次性校验所需字段，原始恢复码从未进入数据库或此行模型。 */
interface RecoveryCredentialRow {
  recoveryHash: string;
  recoverySalt: string;
  recoveryUsedAt: Date | null;
}

/**
 * PostgreSQL 认证仓储负责单管理员凭据、会话摘要与登录失败状态。
 * 所有动态值都经 `$n` 参数绑定；事务回调内每条语句只使用同一个 SqlExecutor，
 * 避免池级查询越过初始化或密码恢复的提交/回滚边界。
 */
export class PostgresAuthRepository implements AuthRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async isInitialized(): Promise<boolean> {
    const result = await this.database.query<{ initialized: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM admin_credentials
          WHERE id = 1
       ) AS initialized`,
    );
    return result.rows[0]?.initialized === true;
  }

  public async initialize(input: HashedAdminSetup): Promise<void> {
    try {
      await this.database.transaction(async (transaction) => {
        // 凭据与初始设置必须在同一连接内共同提交；任何第二条写入故障都会回滚敏感认证状态。
        await insertAdministrator(transaction, input);
        await insertInitialSettings(transaction, input);
      });
    } catch (error) {
      // 并发初始化最终由 id=1 主键/唯一约束裁决，只暴露受控冲突而不泄漏 pg 错误细节。
      if (isUniqueViolation(error)) throw new AuthInitializationConflictError();
      throw error;
    }
  }

  public async getLoginAttempt(): Promise<LoginAttemptRecord | null> {
    const result = await this.database.query<LoginAttemptRow>(
      `SELECT failed_count AS "failedCount",
              locked_until AS "lockedUntil"
         FROM login_attempts
        WHERE id = 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      failedCount: row.failedCount,
      lockedUntil: toIsoOrNull(row.lockedUntil),
    };
  }

  public async getPasswordCredential(): Promise<PasswordCredential | null> {
    const result = await this.database.query<PasswordCredentialRow>(
      `SELECT password_hash AS "passwordHash",
              password_salt AS "passwordSalt"
         FROM admin_credentials
        WHERE id = 1`,
    );
    return result.rows[0] ?? null;
  }

  public async createSession(session: StoredSession): Promise<void> {
    // 仅保存随机 Cookie 的 SHA-256 摘要；原始 token 不属于仓储 DTO，无法被误写或回显。
    await this.database.query(
      `INSERT INTO sessions (id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      [session.id, session.tokenHash, session.expiresAt, session.createdAt],
    );
  }

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
      recoveryUsedAt: toIsoOrNull(row.recoveryUsedAt),
    };
  }

  public async resetPassword(input: PasswordResetWrite): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // 四项安全状态必须共享事务执行器：新密码与恢复码消费先写，任何后续故障仍会整体回滚。
      await transaction.query(
        `UPDATE admin_credentials
            SET password_hash = $1,
                password_salt = $2,
                recovery_used_at = $3
          WHERE id = 1`,
        [input.passwordHash, input.passwordSalt, input.recoveryUsedAt],
      );
      await transaction.query(
        `UPDATE sessions
            SET revoked_at = $1
          WHERE revoked_at IS NULL`,
        [input.sessionRevokedAt],
      );
      await transaction.query("DELETE FROM login_attempts WHERE id = 1");
    });
  }

  public async revokeSession(tokenHash: string, now: string): Promise<void> {
    // 撤销按摘要且仅更新活动会话，重复退出不暴露会话是否存在，保持既有幂等安全语义。
    await this.database.query(
      `UPDATE sessions
          SET revoked_at = $1
        WHERE token_hash = $2
          AND revoked_at IS NULL`,
      [now, tokenHash],
    );
  }

  public async isSessionValid(tokenHash: string, now: string): Promise<boolean> {
    const result = await this.database.query<{ valid: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM sessions
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > $2
       ) AS valid`,
      [tokenHash, now],
    );
    return result.rows[0]?.valid === true;
  }

  public async saveLoginAttempt(input: LoginAttemptRecord): Promise<void> {
    // 单例 upsert 原子替换服务已计算的次数与绝对解锁时间，不保存失败密码或请求来源。
    await this.database.query(
      `INSERT INTO login_attempts (id, failed_count, locked_until)
       VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE
             SET failed_count = EXCLUDED.failed_count,
                 locked_until = EXCLUDED.locked_until`,
      [input.failedCount, input.lockedUntil],
    );
  }

  public async clearLoginAttempt(): Promise<void> {
    // 清理不存在的单例记录仍视为成功，供登录成功、锁定到期和密码恢复复用幂等语义。
    await this.database.query("DELETE FROM login_attempts WHERE id = 1");
  }
}

/** 管理员凭据 INSERT 只接受已派生材料；明文密码和恢复码不存在于仓储输入。 */
async function insertAdministrator(
  transaction: SqlExecutor,
  input: HashedAdminSetup,
): Promise<void> {
  await transaction.query(
    `INSERT INTO admin_credentials (
       id,
       password_hash,
       password_salt,
       recovery_hash,
       recovery_salt,
       created_at
     ) VALUES (1, $1, $2, $3, $4, $5)`,
    [
      input.passwordHash,
      input.passwordSalt,
      input.recoveryHash,
      input.recoverySalt,
      input.createdAt,
    ],
  );
}

/** 初始设置与管理员凭据共用 createdAt，确保同一初始化事务留下可审计的一致时间点。 */
async function insertInitialSettings(
  transaction: SqlExecutor,
  input: HashedAdminSetup,
): Promise<void> {
  await transaction.query(
    `INSERT INTO settings (
       id,
       enabled_regions_json,
       default_search_region,
       created_at,
       updated_at
     ) VALUES (1, $1::jsonb, $2, $3, $3)`,
    [
      JSON.stringify(input.initialSettings.enabledRegions),
      input.initialSettings.defaultSearchRegion,
      input.createdAt,
    ],
  );
}

/** 只把 PostgreSQL 标准唯一冲突映射为初始化竞争，其他数据库/事务错误必须原样保留供回滚测试观察。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * pg 的 TIMESTAMPTZ 正常返回 Date；显式校验避免异常适配器值被 String() 静默接受并破坏锁定判断。
 * null 表示未锁定或恢复码未消费，是认证领域允许的唯一空时间。
 */
function toIsoOrNull(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("认证时间字段无效");
  }
  return value.toISOString();
}
