import { describe, expect, it, vi } from "vitest";

import { handleSettingsRoute } from "../src/routes/settings-routes";
import { ProxyConnectionTestBusyError } from "../src/services/proxy-connection-test-service";

describe("settings proxy API boundary", () => {
  it("accepts a validated proxy patch only when the Node route enables proxy support", async () => {
    // Node PostgreSQL 路由允许保存无认证代理；字段仍由服务端白名单解析，不能把凭据或完整 URL 交给仓储。
    const update = vi.fn().mockResolvedValue({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } });
    const response = await handleSettingsRoute(new Request("https://example.test/api/settings", {
      method: "PATCH",
      headers: { cookie: "session=valid" },
      body: JSON.stringify({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } }),
    }), {
      sessions: { authenticate: vi.fn().mockResolvedValue(true) },
      settings: { get: vi.fn(), update },
      proxySupported: true,
    });

    expect(response?.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } }, expect.any(String));
  });

  it("rejects proxy fields on the Worker-compatible route", async () => {
    // Cloudflare Worker/D1 没有代理列；拒绝而不是忽略，避免管理员误以为代理已保存。
    const update = vi.fn();
    const response = await handleSettingsRoute(new Request("https://example.test/api/settings", {
      method: "PATCH",
      headers: { cookie: "session=valid" },
      body: JSON.stringify({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } }),
    }), {
      sessions: { authenticate: vi.fn().mockResolvedValue(true) },
      settings: { get: vi.fn(), update },
    });

    expect(response?.status).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });

  it("requires admin authentication before accepting the fixed proxy test", async () => {
    // 连接测试即使不写数据库也会触发外部请求；匿名请求必须先被会话守卫拦截，不能借此探测 NAS 网络。
    const proxyTest = { test: vi.fn().mockResolvedValue({ http: "proxy-success", browser: "proxy-success" }) };
    const response = await handleSettingsRoute(new Request("https://example.test/api/settings/proxy/test", {
      method: "POST",
      body: JSON.stringify({ enabled: true, protocol: "http", host: "proxy.test", port: 7890 }),
    }), {
      sessions: { authenticate: vi.fn().mockResolvedValue(false) },
      settings: { get: vi.fn(), update: vi.fn() },
      proxySupported: true,
      proxyTest,
    });

    expect(response?.status).toBe(401);
    expect(proxyTest.test).not.toHaveBeenCalled();
  });

  it("maps a concurrent proxy test to the stable 409 code", async () => {
    // 浏览器测试互斥冲突不应被误报为 500；页面可保留草稿并在第一项结束后重试。
    const response = await handleSettingsRoute(new Request("https://example.test/api/settings/proxy/test", {
      method: "POST",
      headers: { cookie: "session=valid" },
      body: JSON.stringify({ enabled: true, protocol: "http", host: "proxy.test", port: 7890 }),
    }), {
      sessions: { authenticate: vi.fn().mockResolvedValue(true) },
      settings: { get: vi.fn(), update: vi.fn() },
      proxySupported: true,
      proxyTest: { test: vi.fn().mockRejectedValue(new ProxyConnectionTestBusyError()) },
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({ code: "PROXY_TEST_BUSY", error: "代理连接测试正在进行。" });
  });
});
