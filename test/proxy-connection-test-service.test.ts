import { describe, expect, it, vi } from "vitest";

import {
  ProxyConnectionTestBusyError,
  ProxyConnectionTestService,
} from "../src/services/proxy-connection-test-service";

describe("ProxyConnectionTestService", () => {
  it("temporarily enables the draft and tests fixed HTTP and browser targets without persistence", async () => {
    // 页面上的 enabled 只决定保存后的业务流量；管理员在关闭状态下点测试时仍必须验证填写的代理端点，而不是误报直连成功。
    const outbound = {
      probe: vi.fn().mockResolvedValue({ path: "proxy", response: new Response("ok", { status: 200 }) }),
    };
    const browser = { probe: vi.fn().mockResolvedValue("proxy-success" as const) };
    const service = new ProxyConnectionTestService(outbound, browser);

    await expect(service.test({ enabled: false, protocol: "http", host: "proxy.test", port: 7890 })).resolves.toEqual({
      http: "proxy-success",
      browser: "proxy-success",
    });
    expect(outbound.probe).toHaveBeenCalledWith(
      { enabled: true, protocol: "http", host: "proxy.test", port: 7890 },
      "https://www.nintendo.com/robots.txt",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(browser.probe).toHaveBeenCalledWith(
      { enabled: true, protocol: "http", host: "proxy.test", port: 7890 },
      "https://store-jp.nintendo.com/robots.txt",
      expect.any(AbortSignal),
    );
  });

  it("allows only one concurrent test and releases the lock after completion", async () => {
    // 连接测试可能启动 Chromium；互斥锁防止同一 NAS 同时创建两套浏览器和两组代理连接，结束后必须无论成功失败都释放。
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const outbound = { probe: vi.fn(async () => { await pending; return { path: "proxy" as const, response: new Response(null, { status: 204 }) }; }) };
    const service = new ProxyConnectionTestService(outbound, { probe: vi.fn().mockResolvedValue("proxy-success" as const) });
    const first = service.test({ enabled: true, protocol: "http", host: "proxy.test", port: 7890 });

    await expect(service.test({ enabled: true, protocol: "http", host: "proxy.test", port: 7890 }))
      .rejects.toBeInstanceOf(ProxyConnectionTestBusyError);
    release();
    await expect(first).resolves.toEqual({ http: "proxy-success", browser: "proxy-success" });
    await expect(service.test({ enabled: true, protocol: "http", host: "proxy.test", port: 7890 }))
      .resolves.toEqual({ http: "proxy-success", browser: "proxy-success" });
  });
});

