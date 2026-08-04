import { describe, expect, it, vi } from "vitest";

import { createLocalBrowserLauncher } from "../src/providers/playwright/browser-launcher";
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
