import { describe, expect, it, vi } from "vitest";

import { handleSettingsRoute } from "../src/routes/settings-routes";
import { ProxyConnectionTestBusyError } from "../src/services/proxy-connection-test-service";
import type { SettingsService } from "../src/services/settings-service";

/** 设置代理 API 仅在 Node/PostgreSQL 运行时暴露，并始终先经过管理员会话守卫。 */
describe("settings proxy API boundary", () => {
  it("accepts a validated proxy patch only when the Node route enables proxy support", async () => {
    // 无认证四字段经白名单解析后才进入服务层；完整 URL、用户名和密码没有被忽略或透传的机会。
    const update = vi.fn().mockResolvedValue({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } });
    const response = await handleSettingsRoute(
      new Request("https://example.test/api/settings", {
        method: "PATCH",
        headers: { cookie: "session=valid" },
        body: JSON.stringify({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } }),
      }),
      { authenticate: vi.fn().mockResolvedValue(true) },
      { get: vi.fn(), update } as unknown as SettingsService,
      true,
    );

    expect(response?.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } }, expect.any(String));
  });

  it("rejects proxy fields when the runtime has not installed proxy support", async () => {
    // 不支持代理的运行时必须明确拒绝而非静默忽略，避免管理员误以为端点已保存。
    const update = vi.fn();
    const response = await handleSettingsRoute(
      new Request("https://example.test/api/settings", {
        method: "PATCH",
        headers: { cookie: "session=valid" },
        body: JSON.stringify({ proxy: { enabled: true, protocol: "http", host: "proxy.test", port: 7890 } }),
      }),
      { authenticate: vi.fn().mockResolvedValue(true) },
      { get: vi.fn(), update } as unknown as SettingsService,
    );

    expect(response?.status).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the local-development access bypass while mapping concurrent tests to 409", async () => {
    // 当前项目明确处于本机开发期，所有管理路由共用直入守卫；代理测试不能自行恢复密码检查，但并发冲突仍要保留稳定可重试状态码。
    const test = vi.fn().mockResolvedValue({ http: "proxy-success", browser: "proxy-success" });
    const anonymous = await handleSettingsRoute(
      new Request("https://example.test/api/settings/proxy/test", { method: "POST", body: JSON.stringify({ enabled: true, protocol: "http", host: "proxy.test", port: 7890 }) }),
      { authenticate: vi.fn().mockResolvedValue(false) },
      { get: vi.fn(), update: vi.fn() } as unknown as SettingsService,
      true,
      { test },
    );
    expect(anonymous?.status).toBe(200);
    expect(test).toHaveBeenCalledOnce();

    const busy = await handleSettingsRoute(
      new Request("https://example.test/api/settings/proxy/test", { method: "POST", headers: { cookie: "session=valid" }, body: JSON.stringify({ enabled: true, protocol: "http", host: "proxy.test", port: 7890 }) }),
      { authenticate: vi.fn().mockResolvedValue(true) },
      { get: vi.fn(), update: vi.fn() } as unknown as SettingsService,
      true,
      { test: vi.fn().mockRejectedValue(new ProxyConnectionTestBusyError()) },
    );
    expect(busy?.status).toBe(409);
    await expect(busy?.json()).resolves.toEqual({ code: "PROXY_TEST_BUSY", error: "代理连接测试正在进行。" });
  });
});
