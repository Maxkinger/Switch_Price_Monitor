import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase } from "../src/server/database/types";
import { createApiTestDatabase, createTestNodeDispatcher, initializeAndLogin as initializeAdmin, jsonRequest, resetApiTestData } from "./support/api-postgres";

// 文件级请求 helper 复用真实 PostgreSQL 连接池；测试结束显式关闭，避免认证会话连接残留。
let database: AppDatabase;

describe("settings management HTTP routes", () => {
  beforeAll(async () => { database = await createApiTestDatabase(); });
  afterAll(async () => { await database.close(); });

  beforeEach(async () => {
    // 设置是单管理员单例；每轮清空一次性库，保证读取和局部更新都从首次初始化的真实状态开始。
    await resetApiTestData(database);
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
  // 通过真实 PostgreSQL 初始化和登录端点取得 HttpOnly 会话，设置路由不会依赖伪造令牌。
  return (await initializeAdmin(database, { enabledRegions: ["US", "JP"], defaultSearchRegion: "US" })).cookie;
}

async function call(path: string, body?: unknown, cookie?: string, method = "POST"): Promise<Response> {
  // 所有被测路径都应由真实 Node dispatcher 消费；null 会立即暴露路由注册遗漏。
  const response = await createTestNodeDispatcher(database)(jsonRequest(path, body, cookie, method));
  if (!response) throw new Error("设置测试请求未被 Node API 处理");
  return response;
}
