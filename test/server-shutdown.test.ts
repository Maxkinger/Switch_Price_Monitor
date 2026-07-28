import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerDependencies } from "../src/server/app";
import type { ServerConfig } from "../src/server/config";
import {
  startServer,
  type ServerLifecycleController,
} from "../src/server/index";

const temporaryDirectories: string[] = [];
const runningServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  // 即使用例断言中途失败，也先幂等关闭监听器，避免残留端口影响后续测试或开发服务。
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    const canonical = await realpath(directory).catch(() => null);
    if (canonical && basename(canonical).startsWith("switch-price-monitor-server-shutdown-")) {
      await rm(canonical, { recursive: true, force: true });
    }
  }));
});

describe("Node HTTP 服务生命周期", () => {
  it("在端口 0 监听、停止接受新连接并等待在途响应完成", async () => {
    const lifecycle = new TestLifecycleController();
    let releaseRequest: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const dependencies: ServerDependencies = {
      dispatchApi: async (request) => {
        if (new URL(request.url).pathname !== "/api/slow") return null;
        markStarted?.();
        await release;
        return new Response("completed");
      },
    };
    const server = await startServer(
      await createConfig({ shutdownGraceMs: 1_000 }),
      dependencies,
      lifecycle,
    );
    runningServers.push(server);
    const port = await lifecycle.listeningPort;
    const inFlight = fetch(`http://127.0.0.1:${port}/api/slow`);
    await started;

    lifecycle.triggerShutdown();
    await nextEventLoopTurn();
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    releaseRequest?.();

    await expect(inFlight.then((response) => response.text())).resolves.toBe("completed");
    await expect(server.finished()).resolves.toBeUndefined();
  });

  it("在宽限期内完成关停且 close 与 finished 均可重复调用", async () => {
    const lifecycle = new TestLifecycleController();
    const server = await startServer(
      await createConfig({ shutdownGraceMs: 500 }),
      { dispatchApi: async () => null },
      lifecycle,
    );
    runningServers.push(server);
    await lifecycle.listeningPort;
    const startedAt = Date.now();

    const firstClose = server.close();
    const secondClose = server.close();

    expect(secondClose).toBe(firstClose);
    await Promise.all([firstClose, server.finished(), server.finished()]);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("在途请求超过宽限期时强制关闭连接并让 finished 完成", async () => {
    const lifecycle = new TestLifecycleController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const never = new Promise<void>(() => undefined);
    const server = await startServer(
      await createConfig({ shutdownGraceMs: 100 }),
      {
        dispatchApi: async (request) => {
          if (new URL(request.url).pathname !== "/api/never") return null;
          markStarted?.();
          await never;
          return new Response("unreachable");
        },
      },
      lifecycle,
    );
    runningServers.push(server);
    const port = await lifecycle.listeningPort;
    const inFlight = fetch(`http://127.0.0.1:${port}/api/never`);
    // 被强制销毁的请求会拒绝；立即附加处理器，避免测试运行器把预期拒绝先报告为未处理异常。
    const inFlightResult = inFlight.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await started;
    const startedAt = Date.now();

    await server.close();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(server.finished()).resolves.toBeUndefined();
    await expect(inFlightResult).resolves.toBe("rejected");
  });
});

/** 测试控制器不注册真实 SIGTERM/SIGINT，只在内存中触发同一关停回调并记录临时端口。 */
class TestLifecycleController implements ServerLifecycleController {
  // 测试只在本机 loopback 创建临时监听，绝不暴露到局域网或与生产 Compose 端口竞争。
  public readonly listenHostname = "127.0.0.1";
  private shutdown: (() => void) | undefined;
  private resolvePort: ((port: number) => void) | undefined;
  public readonly listeningPort = new Promise<number>((resolve) => {
    this.resolvePort = resolve;
  });

  public subscribe(shutdown: () => void): () => void {
    this.shutdown = shutdown;
    return () => {
      this.shutdown = undefined;
    };
  }

  public onListening(port: number): void {
    this.resolvePort?.(port);
  }

  public triggerShutdown(): void {
    this.shutdown?.();
  }
}

/** 每个用例创建隔离静态根和完整配置；数据库 URL 只是假值且 startServer 不连接数据库。 */
async function createConfig(
  overrides: Partial<Pick<ServerConfig, "shutdownGraceMs">> = {},
): Promise<ServerConfig> {
  const staticDirectory = await mkdtemp(join(tmpdir(), "switch-price-monitor-server-shutdown-"));
  temporaryDirectories.push(staticDirectory);
  await writeFile(join(staticDirectory, "index.html"), "<!doctype html><p>shutdown-test</p>");
  return {
    port: 0,
    databaseUrl: "postgres://example.invalid/not-used-by-start-server",
    cookieSecure: false,
    staticDirectory,
    maximumBodyBytes: 1024,
    shutdownGraceMs: overrides.shutdownGraceMs ?? 500,
  };
}

/** 让 server.close 的停止监听状态进入下一轮事件循环，再验证新连接确实被拒绝。 */
async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
