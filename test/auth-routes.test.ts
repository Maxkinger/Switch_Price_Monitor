import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthRepository } from "../src/repositories/d1/auth-repository";
import { handleAuthRoute, type AuthRouteDependencies } from "../src/routes/auth-routes";
import { AuthService } from "../src/services/auth-service";
import worker, { type Env } from "../src/worker";

describe("authentication HTTP routes", () => {
  beforeEach(async () => {
    // API 测试使用同一 D1 绑定，因此每轮清理认证与设置状态，保证“首次访问”语义可重复验证。
    await env.DB.exec("DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
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
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  it("uses explicit insecure-LAN cookie configuration and ignores forged forwarding headers", async () => {
    // 局域网 HTTP 由可信启动配置明确关闭 Secure；客户端伪造 X-Forwarded-Proto=https 也不能改变 Cookie 属性。
    const auth = new AuthService(new AuthRepository(env.DB));
    await auth.initialize({
      password: "correct-horse-battery-staple",
      enabledRegions: ["US"],
      defaultSearchRegion: "US",
      now: "2026-07-16T00:00:00.000Z",
    });

    const login = await handleAuthRoute(new Request("http://nas.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ password: "correct-horse-battery-staple" }),
    }), {
      auth,
      sessions: auth,
      cookieSecure: false,
      now: () => "2026-07-16T00:01:00.000Z",
    });

    const cookie = login?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(" Secure;");
  });

  it("redacts unknown authentication storage failures", async () => {
    // PostgreSQL URL、SQL 或驱动正文属于内部信息；未知异常只能返回固定 500，不能因已登录或初始化端点而回显。
    const dependencies: AuthRouteDependencies = {
      auth: {
        isInitialized: async () => true,
        initialize: async () => ({ recoveryCode: "unused" }),
        login: async () => { throw new Error("postgres://secret@nas/internal SQL failure"); },
        resetPassword: async () => undefined,
        logout: async () => undefined,
      },
      sessions: { authenticate: async () => false },
      cookieSecure: false,
      now: () => "2026-07-16T00:01:00.000Z",
    };

    const response = await handleAuthRoute(new Request("http://nas.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct-horse-battery-staple" }),
    }), dependencies);

    expect(response?.status).toBe(500);
    await expect(response?.json()).resolves.toEqual({ code: "INTERNAL_ERROR", error: "认证暂时无法处理，请稍后重试。" });
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
});

async function initializeThroughHttp(): Promise<{ recoveryCode: string }> {
  // 让路由测试通过真实初始化接口取得一次性恢复码，避免测试直接访问数据库而掩盖 API 序列化错误。
  const response = await call("/api/auth/initialize", {
    password: "correct-horse-battery-staple",
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "JP",
  });
  expect(response.status).toBe(201);
  return response.json<{ recoveryCode: string }>();
}

async function call(path: string, body?: unknown, cookie?: string | null, method = "POST"): Promise<Response> {
  // 静态资源不会参与认证 API；此绑定若被误用会使测试立刻失败，防止路由遗漏。
  const assets = { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher;
  return worker.fetch!(
    new Request(`https://example.test${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    }) as never,
    { DB: env.DB, ASSETS: assets } as Env,
    {} as ExecutionContext,
  );
}
