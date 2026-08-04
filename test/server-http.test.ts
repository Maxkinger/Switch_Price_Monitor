import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createServerApp } from "../src/server/app";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // 静态资源夹具只存在于系统临时目录，测试结束后由系统回收；不触碰仓库 dist 或用户的构建产物。
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }));
});

describe("Node server HTTP composition", () => {
  it("dispatches health and same-origin API requests before static fallback", async () => {
    // API 分发接收到完整同源 Request，Cookie、方法和请求体不会在 Node 适配层被改写；这保持既有平台中立路由的认证边界。
    const directory = await createStaticDirectory();
    const requests: Request[] = [];
    const app = createServerApp({ staticDirectory: directory, maximumBodyBytes: 64 }, {
      dispatchApi: async (request) => {
        requests.push(request);
        return request.url.endsWith("/api/example") ? Response.json({ method: request.method }) : null;
      },
    });

    await expect(app.fetch(new Request("http://localhost/api/health"))).resolves.toMatchObject({ status: 200 });
    const response = await app.fetch(new Request("http://localhost/api/example", {
      method: "POST",
      headers: { cookie: "session=opaque" },
      body: "ok",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ method: "POST" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("cookie")).toBe("session=opaque");
  });

  it("returns safe API 404, serves assets, falls back client routes, and rejects traversal", async () => {
    // 静态路径必须先归一化并约束在 build 根内；/api 未命中不能回退 index.html，避免前端把拼写错误误当作成功页面。
    const directory = await createStaticDirectory();
    const app = createServerApp({ staticDirectory: directory, maximumBodyBytes: 64 }, { dispatchApi: async () => null });

    await expect(app.fetch(new Request("http://localhost/api/unknown"))).resolves.toMatchObject({ status: 404 });
    const asset = await app.fetch(new Request("http://localhost/assets/app.js"));
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    await expect(asset.text()).resolves.toBe("console.log('asset');");
    await expect(app.fetch(new Request("http://localhost/subscriptions/one"))).resolves.toMatchObject({ status: 200 });
    await expect(app.fetch(new Request("http://localhost/%2e%2e/private.txt"))).resolves.toMatchObject({ status: 404 });
  });

  it("rejects oversized request bodies before they reach protected route dispatch", async () => {
    // 内容长度与流式正文都在 HTTP 边界受限，避免认证/订阅 JSON 被无限制缓冲而耗尽 NAS 单进程内存。
    const directory = await createStaticDirectory();
    const dispatchApi = async () => Response.json({ unexpected: true });
    const app = createServerApp({ staticDirectory: directory, maximumBodyBytes: 3 }, { dispatchApi });
    const response = await app.fetch(new Request("http://localhost/api/auth/login", { method: "POST", body: "four" }));
    expect(response.status).toBe(413);
  });
});

/** 创建最小前端构建夹具，验证真实文件读取与客户端路由回退而不依赖仓库现有 dist 状态。 */
async function createStaticDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "switch-price-monitor-server-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<main>Switch Price Monitor</main>");
  await writeFile(join(directory, "assets", "app.js"), "console.log('asset');");
  return directory;
}
