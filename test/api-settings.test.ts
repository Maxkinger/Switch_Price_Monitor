import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";

describe("settings management HTTP routes", () => {
  beforeEach(async () => {
    // 设置是单管理员单例；每轮清空认证与设置记录，保证读取和局部更新都从首次初始化的真实状态开始。
    await env.DB.exec("DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM admin_credentials; DELETE FROM settings;");
  });

  it("returns settings and updates enabled regions, default search region, and theme for the signed-in administrator", async () => {
    // 全局默认搜索区只影响以后新增的商品；本测试验证设置 API 保存管理员偏好，而不是修改任何既有订阅。
    const cookie = await initializeAndLogin();
    const before = await call("/api/settings", undefined, cookie, "GET");
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      enabledRegions: ["US", "JP"],
      defaultSearchRegion: "US",
      theme: "warm-card",
    });

    const updated = await call(
      "/api/settings",
      { enabledRegions: ["JP", "HK"], defaultSearchRegion: "HK", theme: "calm-dark" },
      cookie,
      "PATCH",
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      enabledRegions: ["JP", "HK"],
      defaultSearchRegion: "HK",
      theme: "calm-dark",
    });
  });

  it("rejects a default search region that is not enabled", async () => {
    // 允许保存不在启用列表内的默认区会使后续搜索没有合法来源，因此 API 应在写入前返回明确校验错误。
    const cookie = await initializeAndLogin();
    const response = await call("/api/settings", { enabledRegions: ["JP"], defaultSearchRegion: "US" }, cookie, "PATCH");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "默认搜索区必须属于已选地区。" });
  });
});

async function initializeAndLogin(): Promise<string> {
  // 通过初始化和登录端点取得真实 HttpOnly 会话，保证设置路由的授权逻辑不依赖测试伪造令牌。
  const initialized = await call("/api/auth/initialize", {
    password: "correct-horse-battery-staple",
    enabledRegions: ["US", "JP"],
    defaultSearchRegion: "US",
  });
  expect(initialized.status).toBe(201);

  const login = await call("/api/auth/login", { password: "correct-horse-battery-staple" });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie") ?? "";
}

async function call(path: string, body?: unknown, cookie?: string, method = "POST"): Promise<Response> {
  // 所有被测路径都应由 Worker API 消费；若错误落到静态资源层，500 响应会让测试立即暴露路由遗漏。
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
