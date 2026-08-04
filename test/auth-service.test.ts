import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthRepository } from "../src/repositories/d1/auth-repository";
import { AuthService, LoginLockedError, ValidationError } from "../src/services/auth-service";

describe("AuthService", () => {
  // 直接复用测试池绑定的 D1，确保初始化、会话和恢复码行为在 Worker 运行时验证。
  const auth = new AuthService(new AuthRepository(env.DB));

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

  it("does not revoke a new session or clear a new lockout when a stale D1 recovery write loses the race", async () => {
    // 先确定第一次恢复已消费恢复码，再人为建立新密码生命周期中的会话与失败计数；第二个旧恢复事务必须只返回已消费分类，绝不能撤销这些后来状态。
    await initializeAdministrator(auth);
    const repository = new AuthRepository(env.DB);
    await repository.resetPassword({
      passwordHash: "first-reset-password-hash",
      passwordSalt: "first-reset-password-salt",
      recoveryUsedAt: "2026-07-16T00:01:00.000Z",
      sessionRevokedAt: "2026-07-16T00:01:00.000Z",
    });
    await repository.createSession({
      id: "session-created-after-first-reset",
      tokenHash: "session-hash-created-after-first-reset",
      expiresAt: "2026-08-16T00:02:00.000Z",
      createdAt: "2026-07-16T00:02:00.000Z",
    });
    await repository.saveLoginAttempt({ failedCount: 2, lockedUntil: null });

    await expect(repository.resetPassword({
      passwordHash: "stale-second-reset-password-hash",
      passwordSalt: "stale-second-reset-password-salt",
      recoveryUsedAt: "2026-07-16T00:03:00.000Z",
      sessionRevokedAt: "2026-07-16T00:03:00.000Z",
    })).rejects.toMatchObject({ message: "恢复状态已被消费。" });

    await expect(repository.isSessionValid("session-hash-created-after-first-reset", "2026-07-16T00:04:00.000Z")).resolves.toBe(true);
    await expect(repository.getLoginAttempt()).resolves.toEqual({ failedCount: 2, lockedUntil: null });
  });

  it("does not clear new-credential failures when an old verified D1 credential can no longer create a session", async () => {
    // 旧密码 PBKDF2 完成后密码恢复可以先提交；随后旧凭据建立会话必须失败，并且不能删除恢复后新密码已产生的失败记录。
    await initializeAdministrator(auth);
    const repository = new AuthRepository(env.DB);
    const oldCredential = await repository.getPasswordCredential();
    if (!oldCredential) throw new Error("测试旧密码材料缺失。");
    await repository.resetPassword({
      passwordHash: "new-credential-password-hash",
      passwordSalt: "new-credential-password-salt",
      recoveryUsedAt: "2026-07-16T00:01:00.000Z",
      sessionRevokedAt: "2026-07-16T00:01:00.000Z",
    });
    await repository.saveLoginAttempt({ failedCount: 1, lockedUntil: null });

    await expect(repository.establishSession({
      expectedCredential: oldCredential,
      session: {
        id: "session-from-stale-credential",
        tokenHash: "session-hash-from-stale-credential",
        expiresAt: "2026-08-16T00:02:00.000Z",
        createdAt: "2026-07-16T00:02:00.000Z",
      },
      now: "2026-07-16T00:02:00.000Z",
    })).resolves.toBe("credential-changed");

    await expect(repository.getLoginAttempt()).resolves.toEqual({ failedCount: 1, lockedUntil: null });
    await expect(repository.isSessionValid("session-hash-from-stale-credential", "2026-07-16T00:03:00.000Z")).resolves.toBe(false);
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
