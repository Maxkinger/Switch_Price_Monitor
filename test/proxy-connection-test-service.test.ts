import { describe, expect, it, vi } from "vitest";

import { ProxyConnectionTestBusyError, ProxyConnectionTestService } from "../src/services/proxy-connection-test-service";

/** 连接测试必须临时启用当前草稿、使用固定目标，并在结束后释放 Chromium 互斥锁。 */
describe("ProxyConnectionTestService", () => {
  it("temporarily enables a disabled draft and independently tests fixed HTTP and browser targets", async () => {
    // 页面开关只影响保存后业务流量；管理员关闭代理时点测试仍要验证填写端点，而不能误报原有直连成功。
    const outbound = { probe: vi.fn().mockResolvedValue({ path: "proxy", response: new Response("ok") }) };
    const browser = { probe: vi.fn().mockResolvedValue("proxy-success" as const) };
    const service = new ProxyConnectionTestService(outbound, browser);

    await expect(service.test({ enabled: false, protocol: "http", host: "proxy.test", port: 7890 })).resolves.toEqual({
      http: "proxy-success", browser: "proxy-success",
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
    // 同时创建多组代理请求和 Chromium 会放大 NAS 资源占用；无论结果如何，首个测试完成后下一次应可安全重试。
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const outbound = { probe: vi.fn(async () => { await pending; return { path: "proxy" as const, response: new Response() }; }) };
    const service = new ProxyConnectionTestService(outbound, { probe: vi.fn().mockResolvedValue("proxy-success" as const) });
    const settings = { enabled: true, protocol: "http" as const, host: "proxy.test", port: 7890 };
    const first = service.test(settings);

    await expect(service.test(settings)).rejects.toBeInstanceOf(ProxyConnectionTestBusyError);
    release();
    await expect(first).resolves.toEqual({ http: "proxy-success", browser: "proxy-success" });
    await expect(service.test(settings)).resolves.toEqual({ http: "proxy-success", browser: "proxy-success" });
  });
});
