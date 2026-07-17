import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthService, LoginLockedError, ValidationError } from "../src/worker/services/auth-service";

describe("AuthService", () => {
  // 直接复用测试池绑定的 D1，确保初始化、会话和恢复码行为在 Worker 运行时验证。
  const auth = new AuthService(env.DB);

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
