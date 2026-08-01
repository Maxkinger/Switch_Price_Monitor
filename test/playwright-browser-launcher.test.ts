import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createLocalBrowserLauncher } from "../src/providers/playwright/browser-launcher";
import type {
  BrowserContextLike,
  BrowserLike,
  BrowserPageLike,
} from "../src/providers/playwright/japanese-upgrade-browser";

/**
 * 启动参数用例只向 launcher 注入最窄的 Playwright 模块替身，不读取本机路径；末尾 smoke 才启动真实本地浏览器。
 * 全组不访问公网或任天堂，断言生产启动只能是本地 Chromium、无远程/CDP/调试参数，并且不得泄漏底层异常。
 */
describe("local Playwright browser launcher", () => {
  it("launches local Chromium headlessly with no remote or debugging options", async () => {
    // 若实现增加 connect/CDP/persistent context/debugging port，或把未批准参数传给 chromium.launch，本例必须失败。
    const browser = { newContext: vi.fn(), close: vi.fn() };
    const launch = vi.fn().mockResolvedValue(browser);
    const launcher = createLocalBrowserLauncher(
      { headless: true },
      { chromium: { launch } },
    );

    await expect(launcher.launch()).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith({ headless: true });
  });

  it("passes a non-empty executable path exactly and adds no other launch options", async () => {
    // 可执行文件路径只允许由可信 Node 装配显式提供；launcher 不展开、猜测或写死 M1/NAS 的本机目录。
    const browser = { newContext: vi.fn(), close: vi.fn() };
    const launch = vi.fn().mockResolvedValue(browser);
    const launcher = createLocalBrowserLauncher(
      { headless: true, executablePath: "/opt/project-browser/chromium" },
      { chromium: { launch } },
    );

    await launcher.launch();

    expect(launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: "/opt/project-browser/chromium",
    });
  });

  it("omits an empty executable path instead of forwarding an invalid local path", async () => {
    // 空白路径不是有效配置，也不能被 Playwright 当作意外的相对路径；此边界不回显输入内容。
    const browser = { newContext: vi.fn(), close: vi.fn() };
    const launch = vi.fn().mockResolvedValue(browser);
    const launcher = createLocalBrowserLauncher(
      { headless: true, executablePath: "   " },
      { chromium: { launch } },
    );

    await launcher.launch();

    expect(launch).toHaveBeenCalledWith({ headless: true });
  });

  it("launches real local Chromium against a loopback fixture and closes every owned resource", async () => {
    /**
     * 真实 smoke 只监听随机回环端口并返回固定内存 HTML；绝不访问任天堂或公网。
     * page/context/browser/server 全部在 finally 中按所有权释放，使导航、定位或断言失败时也不会遗留 Chromium 进程。
     */
    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<a href="/item/software/D70050000064985/">アップグレードパス</a>');
    });
    let browser: BrowserLike | undefined;
    let context: BrowserContextLike | undefined;
    let page: BrowserPageLike | undefined;
    try {
      fixture.listen(0, "127.0.0.1");
      await once(fixture, "listening");
      const address = fixture.address();
      if (address === null || typeof address === "string") throw new Error("LOOPBACK_FIXTURE_ADDRESS_UNAVAILABLE");

      browser = await createLocalBrowserLauncher({ headless: true }).launch();
      context = await browser.newContext();
      page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const links = await page.locator("a").all();

      expect(links).toHaveLength(1);
      await expect(links[0]!.getAttribute("href")).resolves.toBe("/item/software/D70050000064985/");
    } finally {
      await closeIgnoringFailure(page);
      await closeIgnoringFailure(context);
      await closeIgnoringFailure(browser);
      await closeFixture(fixture);
    }
  }, 30_000);
});

/** smoke 清理不得让一个 close rejection 跳过后续资源；异常正文也不能写入输出或断言快照。 */
async function closeIgnoringFailure(resource: { close(): Promise<void> } | undefined): Promise<void> {
  if (resource === undefined) return;
  try {
    await resource.close();
  } catch {
    // 清理继续；测试主体的失败仍由 Vitest 保留，浏览器错误正文不进入普通日志。
  }
}

/** 只有已进入监听态的回环 fixture 才需异步 close；未启动或已关闭时同步完成，避免失败路径悬挂测试进程。 */
async function closeFixture(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
