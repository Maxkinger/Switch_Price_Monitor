import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("保存配置只返回非秘密摘要，删除后动态 AI 配置立即不可用", async () => {
    // 真实 PostgreSQL 路由验证 Key 仅短暂穿过 PUT；GET、PUT 和 DELETE 的任何 JSON 都不能包含该测试哨兵，防止未来 UI 无意回显。
    const cookie = await initializeAndLogin();
    const apiKey = "settings-api-secret-sentinel";
    const saved = await callAiProvider("PUT", { apiKey, model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" }, cookie);

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ configured: true, model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" });
    const summary = await callAiProvider("GET", undefined, cookie);
    expect(JSON.stringify(await summary.json())).not.toContain(apiKey);

    const deleted = await callAiProvider("DELETE", undefined, cookie);
    expect(deleted.status).toBe(204);
    await expect((await callAiProvider("GET", undefined, cookie)).json()).resolves.toEqual({ configured: false, model: null, apiBaseUrl: null });
  });

  it("拒绝非官方地址而不保存配置", async () => {
    // 地址即使由管理员填写也只能是精确官方 origin；这里阻止 http、路径或第三方主机把未来 Authorization 带离受控边界。
    const cookie = await initializeAndLogin();
    const response = await callAiProvider("PUT", { apiKey: "test-key", model: "deepseek-chat", apiBaseUrl: "https://evil.invalid" }, cookie);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "AI 配置无效。" });
  });

  it("PUT 的畸形 JSON 与字段校验一样返回固定 422", async () => {
    // JSON 解析器的原始位置、正文片段可能间接包含 Key；专用设置接口必须把语法错误收敛为与非法字段相同的安全摘要。
    const cookie = await initializeAndLogin();
    const response = await createTestNodeDispatcher(database, false, new Uint8Array(32).fill(9))(new Request("http://127.0.0.1/api/settings/ai-provider", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: "{ malformed-ai-configuration",
    }));

    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "AI 配置无效。" });
  });

  it("PUT 的非语法请求体读取失败保留脱敏 500", async () => {
    // 传输中断、body stream 错误不代表管理员提交了可修正的 JSON；它们不能被误标为 422，也绝不能把底层错误或可能的正文泄漏给浏览器。
    const cookie = await initializeAndLogin();
    const request = jsonRequest("/api/settings/ai-provider", { apiKey: "not-returned", model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" }, cookie, "PUT");
    const bodyFailure = new Error("body-stream-secret-sentinel");
    vi.spyOn(request, "json").mockRejectedValue(bodyFailure);

    const response = await createTestNodeDispatcher(database, false, new Uint8Array(32).fill(9))(request);

    expect(response?.status).toBe(500);
    const payload = await response?.json();
    expect(payload).toEqual({ code: "INTERNAL_ERROR", error: "AI 配置暂时无法保存，请稍后重试。" });
    expect(JSON.stringify(payload)).not.toContain("body-stream-secret-sentinel");
    expect(JSON.stringify(payload)).not.toContain("not-returned");
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

async function callAiProvider(method: "GET" | "PUT" | "DELETE", body?: unknown, cookie?: string): Promise<Response> {
  // 该专用接口与普通设置使用同一真实 dispatcher；测试显式传入主密钥，避免依赖开发机环境或产生明文回退。
  const response = await createTestNodeDispatcher(database, false, new Uint8Array(32).fill(9))(jsonRequest("/api/settings/ai-provider", body, cookie, method));
  if (!response) throw new Error("AI 配置测试请求未被 Node API 处理");
  return response;
}
