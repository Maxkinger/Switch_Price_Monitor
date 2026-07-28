import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthService, LoginLockedError, ValidationError } from "../src/services/auth-service";
import { D1AuthRepository } from "../src/repositories/auth-repository";
import {
  AuthRecoveryRejectedError,
  type AuthRepository,
} from "../src/repositories/ports";

describe("AuthService", () => {
  // 直接复用测试池绑定的 D1，确保初始化、会话和恢复码行为在 Worker 运行时验证。
  const auth = new AuthService(new D1AuthRepository(env.DB));

  beforeEach(async () => {
    // 认证表彼此有关联；按依赖反向清理，保证每个用例不会继承前一个用例的管理员状态。
    await env.DB.exec("DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
  });

  it("rejects an initial default search region that was not selected", async () => {
    // 默认搜索区若未启用，后续商品搜索会产生不可达地区，因此必须在首次初始化阶段拒绝。
    await expect(
      auth.initialize({
        password: "correct-horse-battery-staple",
        enabledRegions: ["JP"],
        defaultSearchRegion: "US",
        now: "2026-07-16T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("initializes once, returns a recovery code once, and issues a login session", async () => {
    // 恢复码只在初始化响应中出现；数据库只保存其哈希，测试仅验证格式而不固化敏感值。
    const initialized = await auth.initialize({
      password: "correct-horse-battery-staple",
      enabledRegions: ["US", "JP"],
      defaultSearchRegion: "JP",
      now: "2026-07-16T00:00:00.000Z",
    });

    expect(initialized.recoveryCode).toMatch(/^[A-Z0-9-]+$/);
    await expect(
      auth.initialize({
        password: "correct-horse-battery-staple",
        enabledRegions: ["US"],
        defaultSearchRegion: "US",
        now: "2026-07-16T00:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_INITIALIZED" });

    await expect(auth.login("correct-horse-battery-staple", "2026-07-16T00:02:00.000Z")).resolves.toMatchObject({
      token: expect.any(String),
      expiresAt: "2026-08-15T00:02:00.000Z",
    });
  });

  it("locks login for fifteen minutes after five consecutive failed passwords", async () => {
    // 单管理员没有用户枚举问题，失败计数按全局管理员账户保存；五次连续失败后统一锁定，
    // 能抑制暴力猜测，又不会因单次输错而妨碍管理员正常使用。
    await initializeAdministrator(auth);
    const start = "2026-07-16T00:00:00.000Z";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login("incorrect-password", start)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }

    await expect(auth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z")).rejects.toBeInstanceOf(LoginLockedError);
    await expect(auth.login("correct-horse-battery-staple", "2026-07-16T00:16:00.000Z")).resolves.toMatchObject({
      token: expect.any(String),
    });
  });

  it("resets the password with a recovery code, revokes active sessions, and makes the code single-use", async () => {
    // 重设密码是账户恢复路径：成功后必须撤销所有旧会话，且恢复码立即失效，
    // 防止遗失的浏览器 Cookie 或已暴露的恢复码继续取得管理员权限。
    const initialized = await initializeAdministrator(auth);
    const originalSession = await auth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z");

    await auth.resetPassword(initialized.recoveryCode, "a-different-secure-password", "2026-07-16T00:02:00.000Z");

    await expect(auth.authenticate(originalSession.token, "2026-07-16T00:03:00.000Z")).resolves.toBe(false);
    await expect(auth.login("correct-horse-battery-staple", "2026-07-16T00:03:00.000Z")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    await expect(auth.login("a-different-secure-password", "2026-07-16T00:03:00.000Z")).resolves.toMatchObject({
      token: expect.any(String),
    });
    await expect(auth.resetPassword(initialized.recoveryCode, "another-secure-password", "2026-07-16T00:04:00.000Z")).rejects.toMatchObject({
      code: "INVALID_RECOVERY_CODE",
    });
  });

  it("D1 同一绑定的密码恢复等待暂停登录并撤销其随后创建的会话", async () => {
    /**
     * 直接仓储登录在读取旧凭据后暂停；服务层恢复已完成 PBKDF2 并进入同一仓储实例。
     * 旧实现的 reset batch 不排队，会先撤销空会话集，随后登录插入的新会话仍有效；
     * 修复后恢复排在登录之后，必须把该会话一并撤销。
     */
    const repository = new D1AuthRepository(env.DB);
    const auth = new AuthService(repository);
    const initialized = await initializeAdministrator(auth);
    const verifierReached = createWorkerDeferred<void>();
    const releaseVerifier = createWorkerDeferred<void>();
    const resetInvoked = createWorkerDeferred<void>();
    const syntheticSession = {
      id: "synthetic-d1-login-reset-race",
      tokenHash: "b".repeat(64),
      expiresAt: "2026-08-15T00:01:00.000Z",
      createdAt: "2026-07-16T00:01:00.000Z",
    };
    let login: Promise<unknown> | undefined;
    let reset: Promise<void> | undefined;

    try {
      login = repository.performLoginAttempt(
        {
          now: "2026-07-16T00:01:00.000Z",
          maximumFailedLogins: 5,
          lockedUntilOnThreshold: "2026-07-16T00:16:00.000Z",
          session: syntheticSession,
        },
        async (credential) => {
          expect(credential).not.toBeNull();
          verifierReached.resolve();
          await releaseVerifier.promise;
          return true;
        },
      );
      await withinWorkerStage(verifierReached.promise, "D1 登录未进入 verifier");

      const observedRepository = observeResetInvocation(
        repository,
        resetInvoked.resolve,
      );
      reset = new AuthService(observedRepository).resetPassword(
        initialized.recoveryCode,
        "a-different-secure-password",
        "2026-07-16T00:02:00.000Z",
      );
      await withinWorkerStage(resetInvoked.promise, "D1 恢复未进入仓储");
      // 短窗口让旧版未排队 batch 确定完成；新版排队路径返回 false 后由下方释放登录继续推进。
      await settlesWithinWorkerWindow(reset);

      releaseVerifier.resolve();
      await expect(login).resolves.toBe("succeeded");
      await expect(reset).resolves.toBeUndefined();
      await expect(
        repository.isSessionValid(
          syntheticSession.tokenHash,
          "2026-07-16T00:03:00.000Z",
        ),
      ).resolves.toBe(false);
    } finally {
      // 任一断言失败都释放 verifier 并等待两个操作收敛，避免共享 Worker 测试绑定继承未完成队列。
      releaseVerifier.resolve();
      await Promise.allSettled([login, reset].filter(
        (operation): operation is Promise<unknown> => operation !== undefined,
      ));
    }
  });

  it("D1 排队恢复失败后释放同一绑定队列供后续登录", async () => {
    /**
     * 条件恢复使用错误摘要触发受控拒绝；队列 finally 必须仍释放尾节点，
     * 否则随后合法登录会永久等待，形成管理员无法恢复的可用性故障。
     */
    const repository = new D1AuthRepository(env.DB);
    const auth = new AuthService(repository);
    await initializeAdministrator(auth);

    await expect(
      repository.resetPassword({
        passwordHash: "synthetic-password-hash",
        passwordSalt: "synthetic-password-salt",
        recoveryHash: "0".repeat(64),
        recoveryUsedAt: "2026-07-16T00:01:00.000Z",
        sessionRevokedAt: "2026-07-16T00:01:00.000Z",
      }),
    ).rejects.toBeInstanceOf(AuthRecoveryRejectedError);
    await expect(
      auth.login(
        "correct-horse-battery-staple",
        "2026-07-16T00:02:00.000Z",
      ),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("revokes only the session identified by the logout cookie", async () => {
    // 退出登录只撤销当前浏览器令牌；同一管理员在另一受信设备上的会话不应被意外中断。
    await initializeAdministrator(auth);
    const first = await auth.login("correct-horse-battery-staple", "2026-07-16T00:01:00.000Z");
    const second = await auth.login("correct-horse-battery-staple", "2026-07-16T00:02:00.000Z");

    await auth.logout(first.token, "2026-07-16T00:03:00.000Z");

    await expect(auth.authenticate(first.token, "2026-07-16T00:03:00.000Z")).resolves.toBe(false);
    await expect(auth.authenticate(second.token, "2026-07-16T00:03:00.000Z")).resolves.toBe(true);
  });
});

async function initializeAdministrator(auth: AuthService): Promise<{ recoveryCode: string }> {
  // 统一构造符合密码长度和地区约束的初始化数据，使各安全行为用例只关注自己的边界条件。
  return auth.initialize({
    password: "correct-horse-battery-staple",
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
    now: "2026-07-16T00:00:00.000Z",
  });
}

/**
 * 代理仅在服务调用 resetPassword 仓储边界时发出信号；真实 D1 查询、batch 和共享队列仍由原仓储执行。
 * 该信号排除服务层 PBKDF2 耗时，使短窗口只观察恢复操作是否与暂停登录共用队列。
 */
function observeResetInvocation(
  repository: AuthRepository,
  onResetInvoked: () => void,
): AuthRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "resetPassword") {
        return async (
          input: Parameters<AuthRepository["resetPassword"]>[0],
        ) => {
          onResetInvoked();
          return target.resetPassword(input);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Worker 测试 deferred 只协调合成操作，resolve 幂等以便 finally 安全重复释放。 */
function createWorkerDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let settled = false;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      complete(value);
    };
  });
  return { promise, resolve };
}

/** 阶段超时只防止测试编排泄漏，不作为认证业务顺序的最终断言。 */
async function withinWorkerStage<T>(
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
 * 服务已经进入仓储后给旧 D1 batch 一个短完成窗口；返回值仅用于让未排队旧路径稳定复现，
 * 最终安全结论由恢复完成后的会话有效性断言决定。
 */
async function settlesWithinWorkerWindow(
  operation: Promise<void>,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 200);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
