import { describe, expect, it, vi } from "vitest";

import { BrowserProxyTransportError, createLocalBrowserLauncher } from "../src/providers/playwright/browser-launcher";
import { createJapaneseUpgradeBrowserBatch } from "../src/providers/playwright/japanese-upgrade-browser";
import type { JapaneseUpgradeRootCandidate } from "../src/providers/official-japanese-upgrade-root";

describe("local Playwright browser launcher", () => {
  it("launches headless local Chromium without a remote control surface", async () => {
    // 本地关系核验只能启动无头 Chromium；测试断言 options 没有 endpoint、CDP、persistent context 或调试端口，避免代理/业务层意外获得远端控制入口。
    const browser = { newContext: vi.fn(), close: vi.fn() };
    const launch = vi.fn().mockResolvedValue(browser);
    const launcher = createLocalBrowserLauncher({ headless: true, executablePath: "/opt/chromium" }, { chromium: { launch } });

    await expect(launcher.launch()).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledExactlyOnceWith({ headless: true, executablePath: "/opt/chromium" });
    expect(Object.keys(launch.mock.calls[0]?.[0] ?? [])).toEqual(["headless", "executablePath"]);
  });

  it.each([
    ["http", "http://127.0.0.1:7890"],
    ["https", "https://127.0.0.1:7890"],
    ["socks5", "socks5://127.0.0.1:7890"],
  ] as const)("maps %s proxy settings without credentials", async (protocol, server) => {
    // Chromium 只接收由四个无认证字段构造出的 server；未知对象中的 username/password 也不得通过展开进入启动参数。
    const browser = { newContext: vi.fn(), close: vi.fn() };
    const launch = vi.fn().mockResolvedValue(browser);
    const launcher = createLocalBrowserLauncher({ headless: true }, { chromium: { launch } });

    await expect(launcher.launch({ proxy: { enabled: true, protocol, host: "127.0.0.1", port: 7890 } })).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledWith({ headless: true, proxy: { server } });
    expect(JSON.stringify(launch.mock.calls)).not.toMatch(/username|password/i);
  });

  it("omits disabled proxy and normalizes IPv6 without exposing credentials", async () => {
    // 关闭代理时必须完全不传 proxy，避免 Chromium 误把关闭状态草稿当作真实出口；IPv6 只在 server URL 中加方括号。
    const launch = vi.fn().mockResolvedValue({ newContext: vi.fn(), close: vi.fn() });
    const launcher = createLocalBrowserLauncher({ headless: true }, { chromium: { launch } });
    await launcher.launch({ proxy: { enabled: false, protocol: "http", host: "::1", port: 7890 } });
    expect(launch).toHaveBeenLastCalledWith({ headless: true });

    await launcher.launch({ proxy: { enabled: true, protocol: "http", host: "::1", port: 7890 } });
    expect(launch).toHaveBeenLastCalledWith({ headless: true, proxy: { server: "http://[::1]:7890" } });
  });

  it("maps proxy launch transport failures to a safe browser error", async () => {
    // 代理启动失败只向上层暴露固定类别，底层 Playwright 错误可能含代理地址或本机路径，不能进入业务结果或页面。
    const launch = vi.fn().mockRejectedValue(new Error("proxy connection refused"));
    const launcher = createLocalBrowserLauncher({ headless: true }, { chromium: { launch } });
    await expect(launcher.launch({ proxy: { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 } }))
      .rejects.toBeInstanceOf(BrowserProxyTransportError);
  });

  it("does not launch for an empty or wholly invalid batch and maps launch failure safely", async () => {
    // 空输入与不安全根 URL 在启动前拒绝，真实 Chromium 启动失败也只能映射为 browser-unavailable，不能把本机路径或异常文本回传给管理员页面。
    const launch = vi.fn().mockRejectedValue(new Error("local browser path detail"));
    const batch = createJapaneseUpgradeBrowserBatch({ launch });
    await expect(batch.resolve([], new AbortController().signal)).resolves.toEqual(new Map());
    const invalidRoot: JapaneseUpgradeRootCandidate = {
      productUrl: "https://invalid.example/",
      canonicalTitle: "Invalid launcher fixture",
      publisher: "Fixture publisher",
    };
    await expect(batch.resolve([invalidRoot], new AbortController().signal))
      .resolves.toEqual(new Map([["https://invalid.example/", { status: "browser-unavailable" }]]));
    expect(launch).not.toHaveBeenCalled();

    const root: JapaneseUpgradeRootCandidate = {
      productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
      canonicalTitle: "Local launcher fixture",
      publisher: "Fixture publisher",
    };
    await expect(batch.resolve([root], new AbortController().signal))
      .resolves.toEqual(new Map([[root.productUrl, { status: "browser-unavailable" }]]));
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
