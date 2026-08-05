import { describe, expect, it } from "vitest";

import { proxyFetch } from "../src/server/network/proxy-agent-factory";
import { createOutboundNetwork } from "../src/server/network/outbound-network";
import { createProxyBrowserConnectionProbe } from "../src/server/network/proxy-browser-probe";
import { startHttpProxyFixture, startSocks5ProxyFixture, startTargetFixture, type RunningFixture } from "./support/proxy-fixtures";

/** 只把随机回环端口传给 Agent；冒烟测试不访问公网、任天堂、Telegram 或开发者局域网代理。 */
describe("local proxy transport smoke", () => {
  it.each(["http", "socks5"] as const)("completes %s HTTP and browser-shaped proxy paths", async (protocol) => {
    const running: RunningFixture[] = [];
    try {
      const target = await startTargetFixture();
      const proxy = protocol === "http" ? await startHttpProxyFixture() : await startSocks5ProxyFixture();
      running.push(target, proxy);
      const settings = { enabled: true, protocol, host: "127.0.0.1", port: Number(new URL(proxy.url).port) } as const;

      const response = await proxyFetch(settings, `${target.url}/robots.txt`);
      await expect(response.text()).resolves.toBe("fixture-ok");

      const network = createOutboundNetwork({
        settings: { readProxySettings: async () => ({ ...settings }) },
        proxyFetch,
      });
      const session = await network.snapshot();
      await expect(session.fetch(`${target.url}/again`)).resolves.toMatchObject({ ok: true, status: 200 });
      expect(session.proxySettings?.protocol).toBe(protocol);

      // 浏览器探测器使用内存浏览器替身验证代理参数和清理边界；真实 Chromium 门禁另由 Node Playwright 测试负责。
      const events: string[] = [];
      const probe = createProxyBrowserConnectionProbe({
        launch: async (options) => ({
          newContext: async () => ({
            newPage: async () => ({
              goto: async () => { events.push(options?.proxy?.enabled ? "proxy-goto" : "direct-goto"); },
              locator: () => ({ all: async () => [] }),
              close: async () => { events.push("page-close"); },
            }),
            close: async () => { events.push("context-close"); },
          }),
          close: async () => { events.push("browser-close"); },
        }),
      });
      await expect(probe.probe({ ...settings }, "https://store-jp.nintendo.com/robots.txt", new AbortController().signal)).resolves.toBe("proxy-success");
      expect(events).toEqual(["proxy-goto", "page-close", "context-close", "browser-close"]);
    } finally {
      for (const fixture of running.reverse()) await fixture.close();
    }
  });
});
