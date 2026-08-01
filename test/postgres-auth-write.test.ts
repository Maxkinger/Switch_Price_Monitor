import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import type { AuthRepository } from "../src/repositories/ports";
import { PostgresAuthRepository } from "../src/repositories/postgres/auth-repository";
import {
  AuthService,
  ConflictError,
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  LoginLockedError,
} from "../src/services/auth-service";
import { createTestDatabase } from "./support/postgres";

/**
 * 认证写路径必须在真实 PostgreSQL 原生时间与事务语义上验证。
 * 夹具只使用合成密码和运行时生成的恢复码/会话令牌；测试不会打印或固化任何秘密值，
 * 并且每例都通过受控辅助器重建 brief 指定的一次性回环测试库。
 */
describe("PostgreSQL 认证仓储与服务", () => {
  let database: AppDatabase;

  beforeEach(async () => {
    // 每例重建 public schema，避免单管理员、失败计数或会话摘要跨用例污染并发与回滚断言。
    database = await createTestDatabase();
  });

  afterEach(async () => {
    // 连接池必须在断言后关闭，否则失败用例也会残留客户端并遮蔽后续事务行为。
    await database.close();
  });

  it("并发首次初始化只产生一个管理员和一份初始设置", async () => {
    // 若仓储先检查再分别写两张表而没有数据库事务/唯一冲突处理，两次调用可能得到部分设置或泄漏原生 SQL 错误。
    const first = createAuth(database);
    const second = createAuth(database);
    const attempts = await Promise.allSettled([
      initialize(first, "2026-07-27T00:00:00.000Z"),
      initialize(second, "2026-07-27T00:00:01.000Z"),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ConflictError);
    await expect(countRows(database, "admin_credentials")).resolves.toBe(1);
    await expect(countRows(database, "settings")).resolves.toBe(1);
  });

  it("初始化事务中途失败时管理员与设置都保持为空", async () => {
    // 第二条事务语句前注入确定故障，第一条凭据 INSERT 已发送但只能在同一真实连接上回滚，不能留下一半初始化状态。
    const failing = failTransactionBeforeQuery(database, 2);
    const auth = createAuth(failing);

    await expect(initialize(auth, "2026-07-27T00:00:00.000Z")).rejects.toThrow("合成事务故障");
    await expect(countRows(database, "admin_credentials")).resolves.toBe(0);
    await expect(countRows(database, "settings")).resolves.toBe(0);
  });

  it("恢复密码原子更新哈希、消费恢复码、撤销全部会话并清空失败计数", async () => {
    // 账户恢复是安全边界：四项状态必须共同提交，旧密码、旧 Cookie 或失败锁定都不能在提交后残留为可用状态。
    const auth = createAuth(database);
    const initialized = await initialize(auth, "2026-07-27T00:00:00.000Z");
    const firstSession = await auth.login(syntheticPassword, "2026-07-27T00:01:00.000Z");
    const secondSession = await auth.login(syntheticPassword, "2026-07-27T00:02:00.000Z");
    await expect(auth.login("synthetic-wrong-password", "2026-07-27T00:03:00.000Z"))
      .rejects.toBeInstanceOf(InvalidCredentialsError);
    const before = await readRecoveryState(database);

    await auth.resetPassword(
      initialized.recoveryCode,
      replacementSyntheticPassword,
      "2026-07-27T00:04:00.000Z",
    );

    const after = await readRecoveryState(database);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordSalt).not.toBe(before.passwordSalt);
    expect(after.recoveryUsedAt?.toISOString()).toBe("2026-07-27T00:04:00.000Z");
    await expect(countActiveSessions(database)).resolves.toBe(0);
    await expect(countRows(database, "login_attempts")).resolves.toBe(0);
    await expect(auth.authenticate(firstSession.token, "2026-07-27T00:05:00.000Z")).resolves.toBe(false);
    await expect(auth.authenticate(secondSession.token, "2026-07-27T00:05:00.000Z")).resolves.toBe(false);
    await expect(auth.login(replacementSyntheticPassword, "2026-07-27T00:05:00.000Z"))
      .resolves.toMatchObject({ expiresAt: "2026-08-26T00:05:00.000Z" });
  });

  it("恢复密码事务中途失败时凭据、恢复状态、会话和失败计数全部不变", async () => {
    // 故障发生在凭据 UPDATE 已执行之后、会话撤销之前；事务若误用池查询会直接暴露为哈希改变或旧状态被部分清理。
    const auth = createAuth(database);
    const initialized = await initialize(auth, "2026-07-27T00:00:00.000Z");
    const session = await auth.login(syntheticPassword, "2026-07-27T00:01:00.000Z");
    await expect(auth.login("synthetic-wrong-password", "2026-07-27T00:02:00.000Z"))
      .rejects.toBeInstanceOf(InvalidCredentialsError);
    const before = await readRecoveryState(database);
    const failingAuth = createAuth(failTransactionBeforeQuery(database, 2));

    await expect(failingAuth.resetPassword(
      initialized.recoveryCode,
      replacementSyntheticPassword,
      "2026-07-27T00:03:00.000Z",
    )).rejects.toThrow("合成事务故障");

    const after = await readRecoveryState(database);
    expect(after).toEqual(before);
    await expect(countActiveSessions(database)).resolves.toBe(1);
    await expect(countRows(database, "login_attempts")).resolves.toBe(1);
    await expect(auth.authenticate(session.token, "2026-07-27T00:04:00.000Z")).resolves.toBe(true);
    await expect(auth.login(syntheticPassword, "2026-07-27T00:04:00.000Z"))
      .resolves.toMatchObject({ token: expect.any(String) });
  });

  it("并发使用同一恢复码只允许一次消费且最终密码属于成功请求", async () => {
    /**
     * 两个服务实例会在 PBKDF2 校验阶段读取同一份未消费恢复状态；数据库必须在条件 UPDATE 中再次比较恢复摘要和消费状态，
     * 不能依赖事务外的旧快照。成功方密码由 settled 下标确定，测试不读取或输出任何派生秘密。
     */
    const initialized = await initialize(createAuth(database), "2026-07-27T00:00:00.000Z");
    const passwords = [
      "synthetic-race-password-first",
      "synthetic-race-password-second",
    ] as const;
    const attempts = await Promise.allSettled([
      createAuth(database).resetPassword(
        initialized.recoveryCode,
        passwords[0],
        "2026-07-27T00:01:00.000Z",
      ),
      createAuth(database).resetPassword(
        initialized.recoveryCode,
        passwords[1],
        "2026-07-27T00:01:01.000Z",
      ),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(InvalidRecoveryCodeError);
    const winningIndex = attempts.findIndex((result) => result.status === "fulfilled");
    await expect(
      createAuth(database).login(passwords[winningIndex], "2026-07-27T00:02:00.000Z"),
    ).resolves.toMatchObject({ token: expect.any(String) });
    await expect(
      createAuth(database).login(passwords[winningIndex === 0 ? 1 : 0], "2026-07-27T00:02:01.000Z"),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("密码恢复等待已读取旧凭据的登录并撤销其随后创建的会话", async () => {
    /**
     * 登录在真实事务内读取旧密码派生值后暂停 verifier；恢复事务同时更新密码并准备撤销会话。
     * 旧实现会先执行会话撤销，再被 login_attempts 行锁阻塞，随后登录插入的新会话逃过撤销；
     * 修复后恢复必须先等待登录持有的管理员凭据共享锁，登录提交的新会话再由恢复事务统一撤销。
     */
    const initialized = await initialize(
      createAuth(database),
      "2026-07-27T00:00:00.000Z",
    );
    const verifierReached = createDeferred<void>();
    const releaseVerifier = createDeferred<void>();
    const resetTransactionStarted = createDeferred<void>();
    const resetSessionsUpdated = createDeferred<void>();
    const releaseResetAfterRevocation = createDeferred<void>();
    const repository = new PostgresAuthRepository(database);
    const syntheticSession = {
      id: "synthetic-login-reset-race-session",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-08-26T00:01:00.000Z",
      createdAt: "2026-07-27T00:01:00.000Z",
    };

    let login: Promise<unknown> | undefined;
    let reset: Promise<void> | undefined;
    try {
      login = repository.performLoginAttempt(
        {
          now: "2026-07-27T00:01:00.000Z",
          maximumFailedLogins: 5,
          lockedUntilOnThreshold: "2026-07-27T00:16:00.000Z",
          session: syntheticSession,
        },
        async (credential) => {
          // 非空凭据证明登录已经取得旧密码快照；暂停点位于真实仓储事务和行锁内部。
          expect(credential).not.toBeNull();
          verifierReached.resolve();
          await releaseVerifier.promise;
          return true;
        },
      );
      await withinTestStage(verifierReached.promise, "登录未到达旧凭据 verifier");

      const observedResetDatabase = observePasswordResetTransaction(database, {
        onTransactionStarted: resetTransactionStarted.resolve,
        onSessionsRevoked: resetSessionsUpdated.resolve,
        releaseAfterSessionsRevoked: releaseResetAfterRevocation.promise,
      });
      reset = createAuth(observedResetDatabase).resetPassword(
        initialized.recoveryCode,
        replacementSyntheticPassword,
        "2026-07-27T00:02:00.000Z",
      );
      await withinTestStage(
        resetTransactionStarted.promise,
        "密码恢复事务未启动",
      );

      /**
       * RED 旧路径会在短窗口内完成 UPDATE sessions 并暂停；GREEN 新路径则被登录持有的
       * admin_credentials 共享锁阻塞。短窗口只分类两种顺序，最终安全断言仍以真实会话状态为准。
       */
      await settlesWithinTestWindow(resetSessionsUpdated.promise);

      releaseVerifier.resolve();
      await expect(login).resolves.toBe("succeeded");
      await withinTestStage(
        resetSessionsUpdated.promise,
        "恢复事务未在登录提交后完成会话撤销",
      );
      releaseResetAfterRevocation.resolve();
      await expect(reset).resolves.toBeUndefined();

      await expect(
        repository.isSessionValid(
          syntheticSession.tokenHash,
          "2026-07-27T00:03:00.000Z",
        ),
      ).resolves.toBe(false);
      await expect(countActiveSessions(database)).resolves.toBe(0);
    } finally {
      /**
       * 任一阶段断言或诊断超时都必须释放两个真实事务并等待回滚/提交完成，
       * 否则 afterEach 的 pool.end 会等待占用连接而把一个普通 RED 伪装成无限挂起。
       */
      releaseVerifier.resolve();
      releaseResetAfterRevocation.resolve();
      await Promise.allSettled([login, reset].filter(
        (operation): operation is Promise<unknown> => operation !== undefined,
      ));
    }
  }, 10_000);

  it("五个并发错误登录形成锁定后在密码验证前拒绝后续正确密码", async () => {
    /**
     * 五个错误请求仍真实并发竞争 PostgreSQL 单例状态，完成后必须串行累计到五次并形成锁定。
     * 正确密码只在锁定已提交后发起，因此本用例验证锁定会在 PBKDF2/密码比较前短路，
     * 不把客户端 Promise 数组顺序误当作 PostgreSQL 对真正并发事务的锁授予承诺。
     */
    await initialize(createAuth(database), "2026-07-27T00:00:00.000Z");
    let passwordVerificationCount = 0;
    const repository = observePasswordVerifications(
      new PostgresAuthRepository(database),
      () => {
        passwordVerificationCount += 1;
      },
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        new AuthService(repository).login(
          "synthetic-concurrent-wrong-password",
          "2026-07-27T00:01:00.000Z",
        )),
    );

    expect(attempts).toSatisfy(
      (results: PromiseSettledResult<unknown>[]) =>
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof InvalidCredentialsError,
        ),
    );
    expect(passwordVerificationCount).toBe(5);
    await expect(
      new AuthService(repository).login(
        syntheticPassword,
        "2026-07-27T00:15:59.999Z",
      ),
    ).rejects.toBeInstanceOf(LoginLockedError);
    // 活跃锁定请求不得进入密码校验；计数必须保持为前五个错误请求对应的五次。
    expect(passwordVerificationCount).toBe(5);
    await expect(countActiveSessions(database)).resolves.toBe(0);

    const stored = await database.query<{
      failedCount: number;
      lockedUntil: Date;
    }>(
      `SELECT failed_count AS "failedCount",
              locked_until AS "lockedUntil"
         FROM login_attempts
        WHERE id = 1`,
    );
    expect(stored.rows[0]?.failedCount).toBe(5);
    expect(stored.rows[0]?.lockedUntil.toISOString()).toBe(
      "2026-07-27T00:16:00.000Z",
    );
  });

  it("成功登录删除失败状态时并发错误登录仍原子取得新的失败窗口", async () => {
    /**
     * 先提交一次错误登录以建立既有 login_attempts，再让合法登录锁定该行并暂停于真实 DELETE 之前。
     * 第二个错误登录把旧 SELECT FOR UPDATE 或新原子 upsert 先提交给 PostgreSQL，随后才释放合法登录；
     * 旧路径会在删除提交后观察到缺行，原子 upsert 则必须取得新的失败窗口。协调器不读取任何参数。
     */
    await initialize(createAuth(database), "2026-07-27T00:00:00.000Z");
    await expect(
      createAuth(database).login(
        "synthetic-preexisting-wrong-password",
        "2026-07-27T00:00:30.000Z",
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    const successfulLoginReachedDelete = createDeferred<void>();
    const invalidLoginSubmittedLockingQuery = createDeferred<void>();
    const releaseSuccessfulLoginDelete = createDeferred<void>();
    const coordinatedDatabase = coordinateLoginAttemptDeletionRace(database, {
      onSuccessfulLoginReachedDelete: successfulLoginReachedDelete.resolve,
      onInvalidLoginSubmittedLockingQuery:
        invalidLoginSubmittedLockingQuery.resolve,
      releaseSuccessfulLoginDelete: releaseSuccessfulLoginDelete.promise,
    });
    const auth = createAuth(coordinatedDatabase);
    let successfulLogin: Promise<unknown> | undefined;
    let invalidLogin: Promise<unknown> | undefined;

    try {
      successfulLogin = auth.login(
        syntheticPassword,
        "2026-07-27T00:01:00.000Z",
      );
      await withinTestStage(
        successfulLoginReachedDelete.promise,
        "合法登录未到达失败状态删除边界",
      );

      invalidLogin = auth.login(
        "synthetic-delete-race-wrong-password",
        "2026-07-27T00:01:01.000Z",
      );
      await withinTestStage(
        invalidLoginSubmittedLockingQuery.promise,
        "并发错误登录未提交失败状态锁定语句",
      );

      releaseSuccessfulLoginDelete.resolve();
      await expect(successfulLogin).resolves.toMatchObject({
        token: expect.any(String),
      });
      await expect(invalidLogin).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );

      const stored = await database.query<{
        failedCount: number;
        lockedUntil: Date | null;
      }>(
        `SELECT failed_count AS "failedCount",
                locked_until AS "lockedUntil"
           FROM login_attempts
          WHERE id = 1`,
      );
      expect(stored.rows).toEqual([
        { failedCount: 1, lockedUntil: null },
      ]);
      await expect(countActiveSessions(database)).resolves.toBe(1);
    } finally {
      // 任何 RED 断言或阶段诊断失败都释放真实事务，避免 pool.end 被占用连接无限阻塞。
      releaseSuccessfulLoginDelete.resolve();
      await Promise.allSettled(
        [successfulLogin, invalidLogin].filter(
          (operation): operation is Promise<unknown> =>
            operation !== undefined,
        ),
      );
    }
  }, 10_000);

  it("用 TIMESTAMPTZ 累积五次失败、锁定十五分钟并在到期成功后清空", async () => {
    // pg 返回 Date，仓储必须规范化为 ISO 字符串；否则服务的 Date.parse 可能错误绕过锁定或无法在到期后重置计数。
    const auth = createAuth(database);
    await initialize(auth, "2026-07-27T00:00:00.000Z");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login("synthetic-wrong-password", "2026-07-27T00:01:00.000Z"))
        .rejects.toBeInstanceOf(InvalidCredentialsError);
    }

    const attempt = await database.query<{ failedCount: number; lockedUntil: Date }>(
      `SELECT failed_count AS "failedCount", locked_until AS "lockedUntil"
         FROM login_attempts
        WHERE id = 1`,
    );
    expect(attempt.rows[0]?.failedCount).toBe(5);
    expect(attempt.rows[0]?.lockedUntil.toISOString()).toBe("2026-07-27T00:16:00.000Z");
    await expect(auth.login(syntheticPassword, "2026-07-27T00:15:59.999Z"))
      .rejects.toBeInstanceOf(LoginLockedError);
    await expect(auth.login(syntheticPassword, "2026-07-27T00:16:00.000Z"))
      .resolves.toMatchObject({ token: expect.any(String) });
    await expect(countRows(database, "login_attempts")).resolves.toBe(0);
  });

  it("会话只按摘要、撤销状态和原生过期时间验证，并支持单会话幂等撤销", async () => {
    // 原始 Cookie 令牌只能短暂存在于服务边界；数据库唯一持久化 SHA-256 摘要，退出不得误撤销另一浏览器会话。
    const auth = createAuth(database);
    await initialize(auth, "2026-07-27T00:00:00.000Z");
    const first = await auth.login(syntheticPassword, "2026-07-27T00:01:00.000Z");
    const second = await auth.login(syntheticPassword, "2026-07-27T00:02:00.000Z");

    await expect(auth.authenticate(first.token, "2026-08-26T00:00:59.999Z")).resolves.toBe(true);
    await expect(auth.authenticate(first.token, "2026-08-26T00:01:00.000Z")).resolves.toBe(false);
    await auth.logout(second.token, "2026-07-27T00:03:00.000Z");
    await auth.logout(second.token, "2026-07-27T00:04:00.000Z");
    await expect(auth.authenticate(second.token, "2026-07-27T00:05:00.000Z")).resolves.toBe(false);
    const stored = await database.query<{ id: string; tokenHash: string }>(
      `SELECT id,
              token_hash AS "tokenHash"
         FROM sessions
        WHERE revoked_at IS NOT NULL`,
    );
    expect(stored.rows).toHaveLength(1);
    // 原始 Cookie 既不能偷懒复用为主键，也不能直接进入摘要列；固定 64 位十六进制证明持久化边界使用 SHA-256 文本。
    expect(stored.rows[0]?.id).not.toBe(second.token);
    expect(stored.rows[0]?.tokenHash).not.toBe(second.token);
    expect(stored.rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

const syntheticPassword = "synthetic-admin-password";
const replacementSyntheticPassword = "synthetic-replacement-password";

/** 为每个并发调用创建独立服务实例，但共享同一个真实连接池和数据库唯一约束。 */
function createAuth(database: AppDatabase): AuthService {
  return new AuthService(new PostgresAuthRepository(database));
}

/** 初始化夹具集中维护合法五区和密码长度，测试只观察安全状态，不复刻 PBKDF2 实现。 */
function initialize(auth: AuthService, now: string): Promise<{ recoveryCode: string }> {
  return auth.initialize({
    password: syntheticPassword,
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
    now,
  });
}

/**
 * 包装真实 AppDatabase，仅在 transaction 回调看到的 SqlExecutor 上于指定查询前抛错。
 * 池级查询、BEGIN/ROLLBACK/COMMIT 与 close 仍由生产实现执行，因此断言覆盖真实回滚而不是测试桩的内存状态。
 */
function failTransactionBeforeQuery(database: AppDatabase, queryNumber: number): AppDatabase {
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    transaction: (work) => database.transaction(async (transaction) => {
      let executed = 0;
      const failingExecutor: SqlExecutor = {
        async query<Row>(sql: string, parameters?: readonly unknown[]) {
          executed += 1;
          if (executed === queryNumber) throw new Error("合成事务故障");
          return transaction.query<Row>(sql, parameters);
        },
      };
      return work(failingExecutor);
    }),
    withAdvisoryLock: (key, work) => database.withAdvisoryLock(key, work),
    close: () => Promise.resolve(),
  };
}

/**
 * 包装真实密码恢复事务以暴露两个确定性观察点：事务回调启动排除服务层 PBKDF2 耗时，
 * 会话撤销完成点用于重现旧顺序。第二个观察点暂停在真实 UPDATE 之后、login_attempts DELETE 之前，
 * 因此不会用测试桩替代数据库锁、事务提交或回滚语义。
 */
function observePasswordResetTransaction(
  database: AppDatabase,
  events: {
    onTransactionStarted: () => void;
    onSessionsRevoked: () => void;
    releaseAfterSessionsRevoked: Promise<void>;
  },
): AppDatabase {
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    transaction: (work) => database.transaction(async (transaction) => {
      // 事务回调已经取得独立连接；此信号排除服务层 PBKDF2 耗时，只观察随后两条真实 UPDATE 的锁顺序。
      events.onTransactionStarted();
      const observedExecutor: SqlExecutor = {
        async query<Row>(sql: string, parameters?: readonly unknown[]) {
          if (/DELETE\s+FROM\s+login_attempts/i.test(sql)) {
            // 到达此语句说明前一条真实 UPDATE sessions 已完成；先暂停可稳定重现“先撤销、后插会话”的旧顺序。
            events.onSessionsRevoked();
            await events.releaseAfterSessionsRevoked;
          }
          return transaction.query<Row>(sql, parameters);
        },
      };
      return work(observedExecutor);
    }),
    withAdvisoryLock: (key, work) => database.withAdvisoryLock(key, work),
    close: () => Promise.resolve(),
  };
}

/**
 * 短窗口只判断恢复事务是否能在登录 verifier 释放前完成 sessions UPDATE：
 * 旧实现返回 true，凭据共享锁修复后返回 false；调用方无论结果如何都会继续释放真实事务。
 */
async function settlesWithinTestWindow(operation: Promise<void>): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 500);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * 轻量 deferred 只协调测试协程，不包含密码、恢复码或会话令牌。
 * resolve 暴露为幂等 Promise 完成入口，使事务内部观察点无需使用定时器。
 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let settled = false;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = (value) => {
      // finally 可能重复释放已经完成的 barrier；幂等处理避免清理路径改变原始测试结果。
      if (settled) return;
      settled = true;
      complete(value);
    };
  });
  return { promise, resolve };
}

/**
 * 阶段超时只负责诊断测试编排故障，不参与事务先后顺序的业务断言。
 * 超时后外层 finally 会释放所有 barrier，因此测试在失败时仍能回滚事务并正常关闭连接池。
 */
async function withinTestStage<T>(
  operation: Promise<T>,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * 仅协调本用例按顺序启动的两个登录事务：第一个在真实失败状态 DELETE 前暂停；
 * 第二个把旧 SELECT FOR UPDATE 或新原子 upsert 交给真实 SqlExecutor 后才发出到达信号。
 * 包装器不检查 parameters，因而不收集密码派生值或会话摘要；事务语义仍完全使用生产 AppDatabase。
 */
function coordinateLoginAttemptDeletionRace(
  database: AppDatabase,
  events: {
    onSuccessfulLoginReachedDelete: () => void;
    onInvalidLoginSubmittedLockingQuery: () => void;
    releaseSuccessfulLoginDelete: Promise<void>;
  },
): AppDatabase {
  let transactionOrder = 0;
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    transaction: (work) => {
      const currentOrder = transactionOrder;
      transactionOrder += 1;
      return database.transaction(async (transaction) => {
        const coordinatedExecutor: SqlExecutor = {
          async query<Row>(
            sql: string,
            parameters?: readonly unknown[],
          ) {
            if (
              currentOrder === 0 &&
              /DELETE\s+FROM\s+login_attempts/i.test(sql)
            ) {
              events.onSuccessfulLoginReachedDelete();
              await events.releaseSuccessfulLoginDelete;
            }
            const isOldLockingSelect =
              /SELECT[\s\S]+FROM\s+login_attempts[\s\S]+FOR\s+UPDATE/i.test(
                sql,
              );
            const isAtomicLockingUpsert =
              /INSERT\s+INTO\s+login_attempts[\s\S]+ON\s+CONFLICT[\s\S]+DO\s+UPDATE[\s\S]+RETURNING/i.test(
                sql,
              );
            if (
              currentOrder === 1 &&
              (isOldLockingSelect || isAtomicLockingUpsert)
            ) {
              // 先调用真实 executor，再发信号，保证控制协程释放 DELETE 时锁定语句已进入 PostgreSQL。
              const pendingQuery = transaction.query<Row>(
                sql,
                parameters,
              );
              events.onInvalidLoginSubmittedLockingQuery();
              return pendingQuery;
            }
            return transaction.query<Row>(sql, parameters);
          },
        };
        return work(coordinatedExecutor);
      });
    },
    withAdvisoryLock: (key, work) => database.withAdvisoryLock(key, work),
    close: () => Promise.resolve(),
  };
}

/**
 * 只统计真实原子登录端口实际进入密码校验的次数；不读取凭据内容，也不改变数据库事务、锁或返回值。
 * 调用方用它证明活跃锁定会在 PBKDF2 前短路，而不是尝试规定真正并发事务的数据库锁授予顺序。
 */
function observePasswordVerifications(
  repository: AuthRepository,
  onPasswordVerification: () => void,
): AuthRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "performLoginAttempt") {
        return (
          input: Parameters<AuthRepository["performLoginAttempt"]>[0],
          verifyPassword: Parameters<AuthRepository["performLoginAttempt"]>[1],
        ) =>
          target.performLoginAttempt(input, async (credential) => {
            onPasswordVerification();
            return verifyPassword(credential);
          });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** COUNT(*) 的 PostgreSQL bigint 由 pg 返回字符串；测试只接受安全的小计数。 */
async function countRows(database: AppDatabase, table: "admin_credentials" | "settings" | "login_attempts"): Promise<number> {
  const result = await database.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? "0");
}

/** 只读取回滚断言需要的派生状态；恢复码哈希和盐不输出到日志或快照。 */
async function readRecoveryState(database: AppDatabase): Promise<{
  passwordHash: string;
  passwordSalt: string;
  recoveryUsedAt: Date | null;
}> {
  const result = await database.query<{
    passwordHash: string;
    passwordSalt: string;
    recoveryUsedAt: Date | null;
  }>(
    `SELECT password_hash AS "passwordHash",
            password_salt AS "passwordSalt",
            recovery_used_at AS "recoveryUsedAt"
       FROM admin_credentials
      WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("认证夹具缺少管理员记录");
  return row;
}

/** 未撤销会话计数证明密码恢复会撤销全部设备，而单会话退出只影响对应摘要。 */
async function countActiveSessions(database: AppDatabase): Promise<number> {
  const result = await database.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL",
  );
  return Number(result.rows[0]?.count ?? "0");
}
