import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleAuthRoute } from "../src/routes/auth-routes";
import type { AppDatabase } from "../src/server/database/types";
import type { AuthService } from "../src/services/auth-service";
import {
  createApiTestDatabase,
  createTestAuthDispatcher,
  jsonRequest,
  resetApiTestData,
} from "./support/api-postgres";

// 文件级 helper 与 describe 生命周期共享同一受守卫连接池；Node project 串行执行确保不会跨文件复用该句柄。
let database: AppDatabase;

describe("authentication HTTP routes", () => {
  beforeAll(async () => {
    database = await createApiTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    // 文件内复用一个受守卫连接池；每轮清空业务表，保证首次初始化、锁定和恢复状态不会跨用例泄漏。
    await resetApiTestData(database);
  });

  it("initializes the administrator and returns an HttpOnly session cookie after login", async () => {
    const initialized = await call("/api/auth/initialize", {
      password: "correct-horse-battery-staple",
      enabledRegions: ["US", "JP"],
      defaultSearchRegion: "JP",
    });
    expect(initialized.status).toBe(201);

    const login = await call("/api/auth/login", { password: "correct-horse-battery-staple" });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("Secure");
  });

  it("reports setup and current-session state without exposing administrator data", async () => {
    // 刷新 SPA 时只能依据两个布尔值恢复界面：是否需首次设置、当前请求的 HttpOnly Cookie 是否有效；响应不得泄露令牌、密码哈希或管理员配置。
    await expect((await call("/api/auth/status", undefined, null, "GET")).json()).resolves.toEqual({ initialized: false, authenticated: false });

    await initializeThroughHttp();
    await expect((await call("/api/auth/status", undefined, null, "GET")).json()).resolves.toEqual({ initialized: true, authenticated: false });

    const login = await call("/api/auth/login", { password: "correct-horse-battery-staple" });
    await expect((await call("/api/auth/status", undefined, login.headers.get("set-cookie"), "GET")).json())
      .resolves.toEqual({ initialized: true, authenticated: true });
  });

  it("returns a retryable lock response after repeated invalid login requests", async () => {
    // HTTP 层必须把服务层的临时锁定显式映射为 429，前端才不会把暴力防护误显示成普通表单校验失败。
    await initializeThroughHttp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const invalid = await call("/api/auth/login", { password: "incorrect-password" });
      expect(invalid.status).toBe(401);
    }

    const locked = await call("/api/auth/login", { password: "correct-horse-battery-staple" });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: "LOGIN_LOCKED" });
  });

  it("resets a password through the recovery endpoint and clears the browser session on logout", async () => {
    // 恢复接口只确认操作是否完成，不回显恢复码或令牌；退出接口必须立即覆盖 Cookie，
    // 让共享设备的浏览器不再继续携带已经撤销的会话标识。
    const initialized = await initializeThroughHttp();
    const initialLogin = await call("/api/auth/login", { password: "correct-horse-battery-staple" });
    expect(initialLogin.status).toBe(200);

    const recovered = await call("/api/auth/recover", {
      recoveryCode: initialized.recoveryCode,
      password: "a-different-secure-password",
    });
    expect(recovered.status).toBe(204);
    expect((await call("/api/auth/login", { password: "correct-horse-battery-staple" })).status).toBe(401);
    expect((await call("/api/auth/login", { password: "a-different-secure-password" })).status).toBe(200);

    const logout = await call("/api/auth/logout", undefined, initialLogin.headers.get("set-cookie"));
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("未知认证依赖异常固定返回 500 且不回显内部消息", async () => {
    /**
     * 合成依赖模拟数据库连接或驱动异常；路由只能返回固定 INTERNAL_ERROR，
     * 不能把可能包含 SQL、表名、连接信息或认证材料的 error.message 交给浏览器。
     */
    const sensitiveMessage = "synthetic database failure with internal table detail";
    const failingAuth = {
      isInitialized: async () => {
        throw new Error(sensitiveMessage);
      },
      authenticate: async () => false,
    } as unknown as AuthService;

    const response = await handleAuthRoute(
      new Request("https://example.test/api/auth/status"),
      { auth: failingAuth, sessions: failingAuth, cookieSecure: true },
    );

    expect(response?.status).toBe(500);
    const body = await response?.json() as { code: string; error: string } | undefined;
    expect(body).toEqual({
      code: "INTERNAL_ERROR",
      error: "认证暂时无法处理，请稍后重试。",
    });
    expect(JSON.stringify(body)).not.toContain(sensitiveMessage);
  });
});

async function initializeThroughHttp(): Promise<{ recoveryCode: string }> {
  // 让路由测试通过真实初始化接口取得一次性恢复码，避免测试直接访问数据库而掩盖 API 序列化错误。
  const response = await call("/api/auth/initialize", {
    password: "correct-horse-battery-staple",
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "JP",
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ recoveryCode: string }>;
}

async function call(path: string, body?: unknown, cookie?: string | null, method = "POST"): Promise<Response> {
  // 认证测试显式启用 Secure，继续锁定 HTTPS Cookie 合同；LAN false/HTTPS true 双分支另由 server-http 回归覆盖。
  const response = await createTestAuthDispatcher(database, true)(
    jsonRequest(path, body, cookie, method),
  );
  if (!response) throw new Error("认证测试请求未被认证路由处理");
  return response;
}
