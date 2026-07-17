import { describe, expect, it, vi } from "vitest";

import { AuthApiError, createAuthApiClient } from "../src/app/auth-api-client";

/**
 * 认证客户端测试固定浏览器与本站 Worker 的边界：管理员密码和恢复码只作为调用参数传递，
 * 绝不由客户端读取 Cookie 或改为调用第三方域名。测试使用的是不可用于真实账户的夹具字符串。
 */
describe("authentication API client", () => {
  it("sends initialization only to the same-origin API with the administrator cookie policy", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ recoveryCode: "TEST-RECOVERY-CODE" }, { status: 201 }));
    const client = createAuthApiClient(request);

    await expect(client.initialize({ password: "fixture-password-1234", enabledRegions: ["US", "HK"], defaultSearchRegion: "US" }))
      .resolves.toEqual({ recoveryCode: "TEST-RECOVERY-CODE" });
    expect(request).toHaveBeenCalledWith("/api/auth/initialize", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "fixture-password-1234", enabledRegions: ["US", "HK"], defaultSearchRegion: "US" }),
    }));
  });

  it("reads setup and verified-session flags without exposing a browser-managed session cookie", async () => {
    // 该响应只让页面决定恢复登录界面还是已认证界面；Cookie 仍由浏览器自动携带，客户端不会读取令牌。
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ initialized: true, authenticated: true }));

    await expect(createAuthApiClient(request).getStatus()).resolves.toEqual({ initialized: true, authenticated: true });
    expect(request).toHaveBeenCalledWith("/api/auth/status", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("turns a safe Worker error summary into a status-aware error without preserving response data", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "登录尝试过多，请稍后再试。", code: "LOGIN_LOCKED" }, { status: 429 }));

    await expect(createAuthApiClient(request).login("fixture-password-1234"))
      .rejects.toEqual(expect.objectContaining({ name: "AuthApiError", message: "登录尝试过多，请稍后再试。", status: 429 }));
    await expect(createAuthApiClient(request).login("fixture-password-1234")).rejects.toBeInstanceOf(AuthApiError);
  });
});
