import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import { PostgresAuthRepository } from "../src/repositories/postgres/auth-repository";
import {
  AuthService,
  ConflictError,
  InvalidCredentialsError,
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
