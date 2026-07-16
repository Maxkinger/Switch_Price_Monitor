import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/worker";

describe("manual refresh HTTP route", () => {
  beforeEach(async () => {
    // 刷新队列与认证单例都跨请求持久化；清理它们可证明本轮的 429 只来自用例内的首次请求。
    await env.DB.exec("DELETE FROM manual_refresh_requests; DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T01:00:00.000Z"));
  });

  afterEach(() => {
    // 恢复真实时钟，防止固定时间意外影响认证过期时间或其他用例对当前时间的业务断言。
    vi.useRealTimers();
  });

  it("queues one administrator refresh request and rejects another request during the fifteen-minute cooldown", async () => {
    // 冷却必须在 Worker 服务端持久化，而非仅靠前端禁用按钮；否则多标签页或直接调用 API 都能造成外部商店请求突发。
    const cookie = await initializeAndLogin();
    const first = await call(cookie);

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({
      status: "queued",
      requestedAt: "2026-07-16T01:00:00.000Z",
      nextAllowedAt: "2026-07-16T01:15:00.000Z",
    });

    vi.setSystemTime(new Date("2026-07-16T01:10:00.000Z"));
    const repeated = await call(cookie);

    expect(repeated.status).toBe(429);
    await expect(repeated.json()).resolves.toEqual({
      code: "REFRESH_COOLDOWN",
      error: "请在冷却结束后再次刷新。",
      nextAllowedAt: "2026-07-16T01:15:00.000Z",
    });
  });
});

async function initializeAndLogin(): Promise<string> {
  // 真实初始化与登录确保刷新端点继承管理员会话安全边界，而不是仅测试一个未受保护的写入路由。
  const initialized = await request("/api/auth/initialize", { password: "correct-horse-battery-staple", enabledRegions: ["US"], defaultSearchRegion: "US" });
  expect(initialized.status).toBe(201);
  const login = await request("/api/auth/login", { password: "correct-horse-battery-staple" });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie") ?? "";
}

async function call(cookie: string): Promise<Response> {
  // 刷新请求必须被 Worker API 消费；若落到静态资源层会返回 500，防止未注册路由被测试误判为成功。
  const assets = { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher;
  return worker.fetch!(new Request("https://example.test/api/refresh", { method: "POST", headers: { cookie } }) as never, { DB: env.DB, ASSETS: assets } as Env, {} as ExecutionContext);
}

async function request(path: string, body: unknown): Promise<Response> {
  const assets = { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher;
  return worker.fetch!(new Request(`https://example.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never, { DB: env.DB, ASSETS: assets } as Env, {} as ExecutionContext);
}
