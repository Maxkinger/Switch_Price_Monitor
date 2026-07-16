import { initialRegionCodes, type InitialSettings } from "../../shared/domain";
import { SettingsRepository } from "../repositories/settings-repository";

/**
 * 认证服务负责单管理员的初始化、密码登录和会话生命周期。
 * 所有秘密只在调用边界短暂存在；D1 中只存派生哈希或令牌摘要，避免数据库副本直接成为登录凭据。
 */
const encoder = new TextEncoder();
// PBKDF2 在 Worker Web Crypto 中可用；10 万次迭代提高离线破解成本，同时保持个人站点首次登录的可接受延迟。
const passwordIterations = 100_000;
// 五次连续失败后锁定十五分钟，兼顾防暴力猜测与管理员偶发输错密码的恢复时间。
const maximumFailedLogins = 5;
const loginLockDurationMs = 15 * 60 * 1000;
// 单次浏览器会话最长三十天；过期后必须重新用管理员密码换取新的随机令牌。
const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;

export class ValidationError extends Error {
  public readonly code = "VALIDATION_ERROR";
}

export class ConflictError extends Error {
  public readonly code = "ALREADY_INITIALIZED";
}

/** 密码错误统一使用相同错误，避免对外暴露管理员是否已初始化等账户状态。 */
export class InvalidCredentialsError extends Error {
  public readonly code = "INVALID_CREDENTIALS";
}

/** 临时锁定应映射为限流响应，而非参数校验错误，前端可据此展示稍后重试提示。 */
export class LoginLockedError extends Error {
  public readonly code = "LOGIN_LOCKED";
}

/** 恢复码已使用、错误或不存在时统一响应，防止攻击者获知其具体生命周期。 */
export class InvalidRecoveryCodeError extends Error {
  public readonly code = "INVALID_RECOVERY_CODE";
}

export class AuthService {
  private readonly settings: SettingsRepository;

  public constructor(private readonly database: D1Database) {
    this.settings = new SettingsRepository(database);
  }

  /**
   * 供首次访问页面选择“初始化”或“登录”界面。只检查单管理员记录是否存在，
   * 绝不返回密码哈希、地区、会话或恢复码状态，避免公开端点扩大认证信息暴露面。
   */
  public async isInitialized(): Promise<boolean> {
    const credential = await this.database.prepare("SELECT id FROM admin_credentials WHERE id = 1").first();
    return Boolean(credential);
  }

  public async initialize(
    input: Omit<InitialSettings, "createdAt"> & { password: string; now: string },
  ): Promise<{ recoveryCode: string }> {
    // 初始地区只能来自当前 MVP 已支持的五区，并且至少选择一项；拒绝未知字符串避免后续抓取无地区配置。
    if (input.enabledRegions.length === 0 || input.enabledRegions.some((region) => !initialRegionCodes.includes(region))) {
      throw new ValidationError("请至少选择一个受支持的地区。");
    }
    // 默认搜索区必须已启用，否则之后的商品搜索没有有效的数据源。
    if (!input.enabledRegions.includes(input.defaultSearchRegion)) {
      throw new ValidationError("默认搜索区必须属于已选地区。");
    }
    if (input.password.length < 16) {
      throw new ValidationError("管理员密码至少需要 16 个字符。");
    }
    const existing = await this.database.prepare("SELECT id FROM admin_credentials WHERE id = 1").first();
    if (existing) throw new ConflictError("初始化已完成。");

    // 恢复码仅在本次响应中返回；数据库始终保存派生哈希而非明文。
    const recoveryCode = makeRecoveryCode();
    const passwordSalt = randomText(16);
    const recoverySalt = randomText(16);
    await this.database.batch([
      this.database
        .prepare("INSERT INTO admin_credentials (id, password_hash, password_salt, recovery_hash, recovery_salt, created_at) VALUES (1, ?, ?, ?, ?, ?)")
        .bind(await deriveHash(input.password, passwordSalt), passwordSalt, await deriveHash(recoveryCode, recoverySalt), recoverySalt, input.now),
    ]);
    await this.settings.saveInitial({
      enabledRegions: input.enabledRegions,
      defaultSearchRegion: input.defaultSearchRegion,
      createdAt: input.now,
    });
    return { recoveryCode };
  }

  /**
   * 校验密码并创建一个新的浏览器会话。失败记录必须在校验前检查锁定状态，
   * 这样锁定期内即使输入正确密码也不能被当作绕过限流的探针。
   */
  public async login(password: string, now: string): Promise<{ token: string; expiresAt: string }> {
    const attempt = await this.database
      .prepare("SELECT failed_count AS failedCount, locked_until AS lockedUntil FROM login_attempts WHERE id = 1")
      .first<{ failedCount: number; lockedUntil: string | null }>();
    const nowMs = Date.parse(now);

    if (attempt?.lockedUntil && Date.parse(attempt.lockedUntil) > nowMs) {
      throw new LoginLockedError("登录尝试过多，请十五分钟后再试。");
    }
    // 锁定已自然到期时先清空失败记录，避免很久以前的输错次数影响下一次登录。
    if (attempt?.lockedUntil) await this.clearLoginAttempts();

    const credential = await this.database.prepare("SELECT password_hash AS passwordHash, password_salt AS passwordSalt FROM admin_credentials WHERE id = 1").first<{ passwordHash: string; passwordSalt: string }>();
    if (!credential || !(await matches(password, credential.passwordSalt, credential.passwordHash))) {
      await this.recordFailedLogin(now, attempt?.lockedUntil ? 0 : (attempt?.failedCount ?? 0));
      throw new InvalidCredentialsError("密码错误。");
    }
    // 成功登录立即清空失败状态，保证旧的错误次数不会影响下一次真正的管理员登录。
    await this.clearLoginAttempts();
    // 浏览器拿到随机令牌，数据库只保存 SHA-256 摘要，数据库泄露时不能直接复用会话。
    const token = randomText(32);
    const expiresAt = new Date(nowMs + sessionDurationMs).toISOString();
    await this.database.prepare("INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(randomText(16), await sha256(token), expiresAt, now).run();
    return { token, expiresAt };
  }

  /**
   * 使用一次性恢复码替换管理员密码，并撤销所有既有会话。
   * 该流程故意不生成或回显新的恢复码：首次恢复码是一次性应急凭据，之后应由已登录管理员走常规改密流程。
   */
  public async resetPassword(recoveryCode: string, password: string, now: string): Promise<void> {
    if (password.length < 16) throw new ValidationError("管理员密码至少需要 16 个字符。");
    const credential = await this.database
      .prepare("SELECT recovery_hash AS recoveryHash, recovery_salt AS recoverySalt, recovery_used_at AS recoveryUsedAt FROM admin_credentials WHERE id = 1")
      .first<{ recoveryHash: string; recoverySalt: string; recoveryUsedAt: string | null }>();
    const normalizedCode = recoveryCode.trim().toUpperCase();
    if (!credential || credential.recoveryUsedAt || !(await matches(normalizedCode, credential.recoverySalt, credential.recoveryHash))) {
      throw new InvalidRecoveryCodeError("恢复码无效或已使用。");
    }

    const passwordSalt = randomText(16);
    // 密码更新、恢复码失效和会话撤销作为同一批写入，避免中途失败留下可继续使用的旧会话。
    await this.database.batch([
      this.database
        .prepare("UPDATE admin_credentials SET password_hash = ?, password_salt = ?, recovery_used_at = ? WHERE id = 1")
        .bind(await deriveHash(password, passwordSalt), passwordSalt, now),
      this.database.prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL").bind(now),
      this.database.prepare("DELETE FROM login_attempts WHERE id = 1"),
    ]);
  }

  /**
   * 撤销当前 Cookie 对应的会话，而不是删除全部会话；请求中不存在或已失效的令牌也保持幂等，
   * 防止退出接口被用作会话存在性的探测信号。
   */
  public async logout(token: string, now: string): Promise<void> {
    await this.database.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now, await sha256(token)).run();
  }

  /**
   * 仅用于受保护路由的会话判断：令牌摘要匹配、未撤销且尚未超过 expires_at 才视为有效。
   * 原始令牌不会被查询结果返回，也不会写入日志。
   */
  public async authenticate(token: string, now: string): Promise<boolean> {
    if (!token) return false;
    const session = await this.database
      .prepare("SELECT id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
      .bind(await sha256(token), now)
      .first();
    return Boolean(session);
  }

  /** 把失败次数累积为单管理员记录，并在第五次失败时写入绝对解锁时间，便于无状态 Worker 判断。 */
  private async recordFailedLogin(now: string, previousFailures: number): Promise<void> {
    const failedCount = previousFailures + 1;
    const lockedUntil = failedCount >= maximumFailedLogins ? new Date(Date.parse(now) + loginLockDurationMs).toISOString() : null;
    await this.database
      .prepare("INSERT INTO login_attempts (id, failed_count, locked_until) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET failed_count = excluded.failed_count, locked_until = excluded.locked_until")
      .bind(failedCount, lockedUntil)
      .run();
  }

  /** 成功认证、密码恢复和锁定到期都复用此清理逻辑，保证下次失败从零开始累计。 */
  private async clearLoginAttempts(): Promise<void> {
    await this.database.prepare("DELETE FROM login_attempts WHERE id = 1").run();
  }
}

/** 使用系统安全随机源生成盐、会话令牌和恢复码片段；绝不能改为可预测的时间或伪随机数。 */
function randomText(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 恢复码采用便于人工抄写的两段五位大写格式；格式化不会降低底层 80 位随机熵。 */
function makeRecoveryCode(): string {
  return randomText(10).toUpperCase().match(/.{1,5}/g)!.join("-");
}

/** 使用不同随机盐派生密码或恢复码哈希，避免两个相同秘密产生可关联的数据库值。 */
async function deriveHash(value: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: passwordIterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

/** 先做固定长度哈希再逐字节比较，减少直接字符串短路比较带来的时间差异。 */
async function matches(value: string, salt: string, expected: string): Promise<boolean> {
  return constantTimeEqual(await deriveHash(value, salt), expected);
}

/** 会话令牌采用快速的 SHA-256 摘要而非 PBKDF2，因为令牌本身具备 256 位随机熵且只需不可回显存储。 */
async function sha256(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

/** 哈希输出统一为十六进制文本，便于 D1 的 TEXT 字段保存和参数化查询。 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 相同长度的摘要逐字节累计差异，避免在首个不同字符处提前结束比较。 */
function constantTimeEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}
