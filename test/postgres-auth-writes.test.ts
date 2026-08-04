import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthRepository } from "../src/repositories/postgres/auth-repository";
import type { AuthRepository as AuthRepositoryPort, SessionEstablishment } from "../src/repositories/ports";
import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import { runMigrations } from "../src/server/database/migrations";
import {
  AuthService,
  LoginLockedError,
} from "../src/services/auth-service";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

/** PostgreSQL 返回的认证事实只用于测试原子性，明文密码、恢复码和原始 Cookie 令牌绝不进入该行模型。 */
interface AuthenticationStateRow {
  passwordHash: string;
  passwordSalt: string;
  recoveryUsedAt: Date | null;
  activeSessions: string;
  failedCount: number | null;
  lockedUntil: Date | null;
}

describe("PostgreSQL 认证写入", () => {
  // 所有破坏性清理都只连接固定回环端口的可丢弃数据库；测试不会读取开发、NAS 或生产凭据。
  const database = createTestDatabase();

  beforeAll(async () => {
    // 正式迁移提供单管理员主键、会话摘要唯一约束和 TIMESTAMPTZ，避免内存桩掩盖真实并发与时区行为。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  beforeEach(async () => {
    // 认证和初始设置是一组生命周期数据；按外键安全顺序清空可确保每例都从“尚未初始化”开始。
    await database.query("TRUNCATE sessions, login_attempts, admin_credentials, settings RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    // 显式关闭连接池，防止悬挂 socket 让后续 PostgreSQL 文件无法重建 disposable schema。
    await database.close();
  });

  it("simultaneous first initialization creates exactly one administrator and one settings row", async () => {
    // 两个进程可同时看到空库；唯一约束和初始化事务必须让一个成功、另一个得到安全冲突，而不是生成半套设置。
    const first = new AuthService(new AuthRepository(database));
    const second = new AuthService(new AuthRepository(database));
    const input = {
      password: "correct-horse-battery-staple",
      enabledRegions: ["US", "JP"] as const,
      defaultSearchRegion: "US" as const,
      now: "2026-07-16T00:00:00.000Z",
    };

    const results = await Promise.allSettled([
      first.initialize({ ...input, enabledRegions: [...input.enabledRegions] }),
      second.initialize({ ...input, enabledRegions: [...input.enabledRegions] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "ALREADY_INITIALIZED", message: "初始化已完成。" },
    });
    await expect(rowCount(database, "admin_credentials")).resolves.toBe(1);
    await expect(rowCount(database, "settings")).resolves.toBe(1);
  });

  it("changes the password, consumes recovery state, revokes every session, and clears lockout state atomically", async () => {
    // 恢复成功必须同时完成四项安全写入；任何旧会话或失败计数残留都会让失窃 Cookie 或旧锁定状态继续影响管理员。
    const auth = new AuthService(new AuthRepository(database));
    const initialized = await initializeAdministrator(auth);
    const firstSession = await auth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z");
    const secondSession = await auth.login("correct-horse-battery-staple", "2026-07-16T00:02:00.000Z");
    await expect(auth.login("incorrect-password", "2026-07-16T00:03:00.000Z")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    const before = await authenticationState(database);

    await auth.resetPassword(initialized.recoveryCode, "a-different-secure-password", "2026-07-16T00:04:00.000Z");

    const after = await authenticationState(database);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordSalt).not.toBe(before.passwordSalt);
    expect(after.recoveryUsedAt?.toISOString()).toBe("2026-07-16T00:04:00.000Z");
    expect(after.activeSessions).toBe("0");
    expect(after.failedCount).toBeNull();
    expect(after.lockedUntil).toBeNull();
    await expect(auth.authenticate(firstSession.token, "2026-07-16T00:05:00.000Z")).resolves.toBe(false);
    await expect(auth.authenticate(secondSession.token, "2026-07-16T00:05:00.000Z")).resolves.toBe(false);
    await expect(auth.login("a-different-secure-password", "2026-07-16T00:05:00.000Z")).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("rolls back every password-reset row when a deterministic failure happens before commit", async () => {
    // 故障执行器在密码行已更新后、会话撤销前抛错；若仓储错误使用池级 query，旧密码或恢复状态就会泄漏为部分提交。
    const stableAuth = new AuthService(new AuthRepository(database));
    const initialized = await initializeAdministrator(stableAuth);
    const firstSession = await stableAuth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z");
    const secondSession = await stableAuth.login("correct-horse-battery-staple", "2026-07-16T00:02:00.000Z");
    await expect(stableAuth.login("incorrect-password", "2026-07-16T00:03:00.000Z")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    const before = await authenticationState(database);
    const failingAuth = new AuthService(new AuthRepository(failOnTransactionQuery(database, 2)));

    await expect(
      failingAuth.resetPassword(initialized.recoveryCode, "a-different-secure-password", "2026-07-16T00:04:00.000Z"),
    ).rejects.toThrow("测试事务故障");

    expect(await authenticationState(database)).toEqual(before);
    await expect(stableAuth.authenticate(firstSession.token, "2026-07-16T00:05:00.000Z")).resolves.toBe(true);
    await expect(stableAuth.authenticate(secondSession.token, "2026-07-16T00:05:00.000Z")).resolves.toBe(true);
    await expect(stableAuth.login("correct-horse-battery-staple", "2026-07-16T00:05:00.000Z")).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("increments and clears login lockout using PostgreSQL UTC timestamps", async () => {
    // TIMESTAMPTZ 可能由 pg 解码为 Date；仓储必须恢复为稳定 UTC ISO 字符串，服务仍按连续五次和十五分钟原规则判断。
    const auth = new AuthService(new AuthRepository(database));
    await initializeAdministrator(auth);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login("incorrect-password", "2026-07-16T00:00:00.000Z")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }

    const locked = await authenticationState(database);
    expect(locked.failedCount).toBe(5);
    expect(locked.lockedUntil?.toISOString()).toBe("2026-07-16T00:15:00.000Z");
    await expect(auth.login("correct-horse-battery-staple", "2026-07-16T00:14:59.999Z")).rejects.toBeInstanceOf(LoginLockedError);
    await expect(auth.login("correct-horse-battery-staple", "2026-07-16T00:15:00.000Z")).resolves.toMatchObject({ token: expect.any(String) });
    await expect(authenticationState(database)).resolves.toMatchObject({ failedCount: null, lockedUntil: null });
  });

  it("does not lose failed-login increments when five invalid passwords race", async () => {
    // 五个请求会在 Web Crypto 派生后并发写同一单例行；仓储必须原子递增并把计数封顶在阈值，不能由读改写覆盖彼此。
    const auth = new AuthService(new AuthRepository(database));
    await initializeAdministrator(auth);

    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => (
      auth.login("incorrect-password", "2026-07-16T00:00:00.000Z")
    )));

    expect(attempts.every((attempt) => attempt.status === "rejected" && attempt.reason?.code === "INVALID_CREDENTIALS")).toBe(true);
    await expect(authenticationState(database)).resolves.toMatchObject({
      failedCount: 5,
      lockedUntil: new Date("2026-07-16T00:15:00.000Z"),
    });
    await expect(auth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z")).rejects.toBeInstanceOf(LoginLockedError);
  });

  it("cannot create a live session from a password verified before reset commits", async () => {
    // 登录在旧密码验证后暂停；恢复事务先更换凭据并撤销会话，随后恢复登录。条件会话事务必须发现凭据版本变化并安全拒绝。
    const repository = new AuthRepository(database);
    const resetAuth = new AuthService(repository);
    const initialized = await initializeAdministrator(resetAuth);
    const paused = pauseSessionEstablishment(repository);
    const racingLogin = new AuthService(paused.repository).login(
      "correct-horse-battery-staple",
      "2026-07-16T00:01:00.000Z",
    );
    await paused.reached;

    await resetAuth.resetPassword(
      initialized.recoveryCode,
      "a-different-secure-password",
      "2026-07-16T00:02:00.000Z",
    );
    paused.release();

    await expect(racingLogin).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", message: "密码错误。" });
    await expect(rowCount(database, "sessions")).resolves.toBe(0);
    await expect(resetAuth.login("a-different-secure-password", "2026-07-16T00:03:00.000Z")).resolves.toMatchObject({ token: expect.any(String) });
  });
});

/** 统一创建符合密码与地区约束的管理员，恢复码仅停留在当前测试调用栈，不写日志或快照。 */
async function initializeAdministrator(auth: AuthService): Promise<{ recoveryCode: string }> {
  return auth.initialize({
    password: "correct-horse-battery-staple",
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
    now: "2026-07-16T00:00:00.000Z",
  });
}

/** 汇总密码、恢复、会话和锁定状态，便于在故障前后做一次完整相等比较而不暴露任何明文秘密。 */
async function authenticationState(database: SqlExecutor): Promise<AuthenticationStateRow> {
  const result = await database.query<AuthenticationStateRow>(
    `SELECT credentials.password_hash AS "passwordHash",
            credentials.password_salt AS "passwordSalt",
            credentials.recovery_used_at AS "recoveryUsedAt",
            (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL) AS "activeSessions",
            attempts.failed_count AS "failedCount",
            attempts.locked_until AS "lockedUntil"
       FROM admin_credentials AS credentials
       LEFT JOIN login_attempts AS attempts ON attempts.id = credentials.id
      WHERE credentials.id = 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("测试管理员状态缺失。");
  return row;
}

/** COUNT(*) 在 pg 中是字符串；测试只处理小规模夹具，显式转换后仍要求安全整数。 */
async function rowCount(database: SqlExecutor, table: "admin_credentials" | "settings" | "sessions"): Promise<number> {
  const result = await database.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count)) throw new Error("测试计数超出安全整数范围。");
  return count;
}

/**
 * 只暂停“条件建立会话”这一窄操作，其余认证读写仍委托真实 PostgreSQL 仓储。
 * 该顺序夹具能稳定重现旧密码已通过 PBKDF2、但 reset 在 INSERT session 前提交的竞态，不依赖计时或 sleep。
 */
function pauseSessionEstablishment(repository: AuthRepositoryPort): {
  repository: AuthRepositoryPort;
  reached: Promise<void>;
  release(): void;
} {
  let markReached!: () => void;
  const reached = new Promise<void>((resolveReached) => {
    markReached = resolveReached;
  });
  let release!: () => void;
  const released = new Promise<void>((resolveReleased) => {
    release = resolveReleased;
  });
  return {
    reached,
    release,
    repository: {
      isInitialized: () => repository.isInitialized(),
      initialize: (input) => repository.initialize(input),
      getLoginAttempt: () => repository.getLoginAttempt(),
      getPasswordCredential: () => repository.getPasswordCredential(),
      createSession: (session) => repository.createSession(session),
      establishSession: async (input): Promise<SessionEstablishment> => {
        markReached();
        await released;
        return repository.establishSession(input);
      },
      recordFailedLogin: (input) => repository.recordFailedLogin(input),
      getRecoveryCredential: () => repository.getRecoveryCredential(),
      resetPassword: (input) => repository.resetPassword(input),
      revokeSession: (tokenHash, now) => repository.revokeSession(tokenHash, now),
      isSessionValid: (tokenHash, now) => repository.isSessionValid(tokenHash, now),
      saveLoginAttempt: (input) => repository.saveLoginAttempt(input),
      clearLoginAttempt: () => repository.clearLoginAttempt(),
    },
  };
}

/**
 * 包装真实数据库并在事务回调的第 N 条语句前抛错。
 * 池级查询保持原样，因此仓储若在事务内误用独立连接，测试会观察到无法回滚的脏写，而不会被 mock 调用次数掩盖。
 */
function failOnTransactionQuery(database: AppDatabase, failingQueryNumber: number): AppDatabase {
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    transaction: (work) => database.transaction(async (transaction) => {
      let queryNumber = 0;
      const failingExecutor: SqlExecutor = {
        query: async (sql, parameters) => {
          queryNumber += 1;
          if (queryNumber === failingQueryNumber) throw new Error("测试事务故障");
          return transaction.query(sql, parameters);
        },
      };
      return work(failingExecutor);
    }),
    withAdvisoryLock: (key, work) => database.withAdvisoryLock(key, work),
    close: () => database.close(),
  };
}
