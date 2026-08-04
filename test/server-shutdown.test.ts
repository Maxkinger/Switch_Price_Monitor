import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startServer } from "../src/server/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }));
});

describe("Node server shutdown", () => {
  it("stops accepting requests while allowing an in-flight API response to finish", async () => {
    // 关闭先停止新连接、再等待正在执行的管理员请求；避免 NAS 升级时截断刷新响应或让连接永远占住 PostgreSQL pool。
    const directory = await createStaticDirectory();
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const server = await startServer({
      port: 0,
      databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
      cookieSecure: false,
      staticDirectory: directory,
      maximumBodyBytes: 1024,
      shutdownGraceMs: 1000,
    }, {
      dispatchApi: async (request) => {
        if (new URL(request.url).pathname !== "/api/wait") return null;
        markEntered();
        await completed;
        return Response.json({ completed: true });
      },
    });
    const address = server.address();
    const pending = fetch(`http://127.0.0.1:${address.port}/api/wait`);
    // 等待请求确实进入业务分发，再触发关闭，避免把尚未建立的连接误判为关闭期间请求。
    await entered;
    const closing = server.close();
    release();

    await expect(pending).resolves.toMatchObject({ status: 200 });
    await expect(closing).resolves.toBeUndefined();
    await expect(server.finished()).resolves.toBeUndefined();
  });
});

/** 关闭测试只需一个 index.html；数据库 URL 不会被 startServer 解引用，避免测试意外连接任何真实实例。 */
async function createStaticDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "switch-price-monitor-shutdown-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "index.html"), "<main>shutdown fixture</main>");
  return directory;
}
