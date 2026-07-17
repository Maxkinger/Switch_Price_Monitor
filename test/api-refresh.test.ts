import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/worker";
import { handleManualRefreshRoute } from "../src/worker/routes/manual-refresh-routes";

/**
 * 测试替身只返回采集聚合数，不携带任天堂响应、商品 URL 或价格正文。
 * 这样可验证受认证路由的同步执行边界，同时避免单元测试向外部官方商店发起真实请求。
 */
interface ImmediateRefreshRunnerStub {
  run(now: string): Promise<{ attempted: number; collected: number; stale: number }>;
}

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

  it("runs one administrator refresh immediately and rejects another request during the fifteen-minute cooldown", async () => {
    // 冷却必须在 Worker 服务端持久化，而非仅靠前端禁用按钮；首次请求获得名额后应在响应前恰好执行一次统一采集。
    const cookie = await initializeAndLogin();
    const runner: ImmediateRefreshRunnerStub = { run: vi.fn().mockResolvedValue({ attempted: 3, collected: 2, stale: 1 }) };
    const first = await call(cookie, runner);

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      status: "completed",
      executedAt: "2026-07-16T01:00:00.000Z",
      attempted: 3,
      collected: 2,
      stale: 1,
    });
    expect(runner.run).toHaveBeenCalledExactlyOnceWith("2026-07-16T01:00:00.000Z");

    vi.setSystemTime(new Date("2026-07-16T01:10:00.000Z"));
    const repeated = await call(cookie, runner);

    expect(repeated.status).toBe(429);
    await expect(repeated.json()).resolves.toEqual({
      code: "REFRESH_COOLDOWN",
      error: "请在冷却结束后再次刷新。",
      nextAllowedAt: "2026-07-16T01:15:00.000Z",
    });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("returns a safe error when the immediate collection runner fails", async () => {
    // 来源或汇率异常不得把内部 URL、SQL 或堆栈回传到已登录浏览器；冷却名额仍已消耗，防止失败时高频重试压垮官方商店。
    const cookie = await initializeAndLogin();
    const runner: ImmediateRefreshRunnerStub = { run: vi.fn().mockRejectedValue(new Error("private upstream failure")) };

    const response = await call(cookie, runner);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "INTERNAL_ERROR",
      error: "刷新暂时无法完成，请稍后重试。",
    });
    expect(runner.run).toHaveBeenCalledExactlyOnceWith("2026-07-16T01:00:00.000Z");
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

async function call(cookie: string, runner: ImmediateRefreshRunnerStub): Promise<Response> {
  // 直接注入无网络采集替身，验证路由在认证、原子冷却通过后等待采集完成；静态资源层不应参与此 API。
  const response = await handleManualRefreshRoute(
    new Request("https://example.test/api/refresh", { method: "POST", headers: { cookie } }),
    env.DB,
    runner,
  );
  if (!response) throw new Error("手动刷新路由未处理 /api/refresh 请求。");
  return response;
}

async function request(path: string, body: unknown): Promise<Response> {
  const assets = { fetch: async () => new Response("unexpected asset request", { status: 500 }) } as unknown as Fetcher;
  return worker.fetch!(new Request(`https://example.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never, { DB: env.DB, ASSETS: assets } as Env, {} as ExecutionContext);
}
