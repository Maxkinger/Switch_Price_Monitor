import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Node production pins the local Playwright runtime dependency", async () => {
  /**
   * 此配置测试只读取受版本控制的清单，不启动 Chromium、不监听端口，也不请求任天堂或公网。
   * Playwright 是 Node 生产运行时依赖；精确版本可防止 Docker 构建下载的浏览器与 JavaScript 客户端静默漂移。
   */
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(manifest.dependencies.playwright, "1.62.0");
  assert.equal(manifest.devDependencies.playwright, undefined);
  assert.equal(
    manifest.codexMetadata.localBrowserDependencyRationaleZh.playwright,
    "playwright 是 Node 日区升级关系的生产运行时依赖；版本必须精确锁定，使本地、Docker 与 NAS 使用同一 Chromium 客户端和浏览器修订。",
  );
});
