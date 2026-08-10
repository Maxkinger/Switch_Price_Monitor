import { describe, expect, it, vi } from "vitest";

import { BrowserProxyTransportError } from "../src/providers/playwright/browser-errors";
import type { BrowserLaunchOptions } from "../src/providers/playwright/japanese-upgrade-browser";
import { createProxyBrowserConnectionProbe } from "../src/server/network/proxy-browser-probe";

/** 固定目标浏览器探测必须清理完整代理资源树后，才允许启动唯一的一次直连回退。 */
describe("proxy browser connection probe", () => {
  it("closes the proxy browser tree before one direct fallback", async () => {
    // 代理导航失败时不能复用半成品页面或 Cookie；必须完整关闭后再启动直连实例，固定目标也不能被重试放大。
    const events: string[] = [];
    const launch = vi.fn(async (options?: BrowserLaunchOptions) => {
      const mode = options?.proxy?.enabled ? "proxy" : "direct";
      events.push(`${mode}-launch`);
      return {
        newContext: async () => {
          events.push(`${mode}-context`);
          return {
            newPage: async () => {
              events.push(`${mode}-page`);
              return {
                goto: async () => {
                  events.push(`${mode}-goto`);
                  if (mode === "proxy") throw new BrowserProxyTransportError("connection");
                },
                locator: () => ({ all: async () => [] }),
                close: async () => { events.push(`${mode}-page-close`); },
              };
            },
            close: async () => { events.push(`${mode}-context-close`); },
          };
        },
        close: async () => { events.push(`${mode}-browser-close`); },
      };
    });

    const probe = createProxyBrowserConnectionProbe({ launch });
    await expect(probe.probe(
      { enabled: true, protocol: "http", host: "proxy.test", port: 7890 },
      "https://store-jp.nintendo.com/robots.txt",
      new AbortController().signal,
    )).resolves.toBe("direct-fallback-success");
    expect(events).toEqual([
      "proxy-launch", "proxy-context", "proxy-page", "proxy-goto", "proxy-page-close", "proxy-context-close", "proxy-browser-close",
      "direct-launch", "direct-context", "direct-page", "direct-goto", "direct-page-close", "direct-context-close", "direct-browser-close",
    ]);
  });
});
