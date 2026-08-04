import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { createLocalBrowserLauncher } from "../src/providers/playwright/browser-launcher";

describe("local Chromium smoke test", () => {
  it("opens a local fixture, reads one link, and closes every browser resource", async () => {
    // smoke test 只提供 127.0.0.1 的静态 HTML，证明 Chromium 生命周期而不访问任天堂或任何互联网地址；真实生产 URL 白名单仍由升级关系适配器负责。
    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<a href="https://store-jp.nintendo.com/item/software/D70050000064985/">アップグレードパス</a>');
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("本地 smoke fixture 未获得 TCP 端口。");

    const browser = await createLocalBrowserLauncher({ headless: true }).launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const links = await page.locator("a").all();
      await expect(links[0]?.getAttribute("href")).resolves.toBe("https://store-jp.nintendo.com/item/software/D70050000064985/");
    } finally {
      // page → context → browser 的关闭顺序与生产批处理一致；fixture 最后关闭，避免残留 Chromium 或监听端口阻塞后续测试。
      await page.close();
      await context.close();
      await browser.close();
      await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    }
  });
});
