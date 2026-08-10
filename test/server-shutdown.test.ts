import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerDependencies } from "../src/server/app";
import type { ServerConfig } from "../src/server/config";
import {
  coordinateServerShutdown,
  resolveListenHostname,
  runServerProcess,
  startServer,
  type ProcessLifecycleController,
  type ServerProcessRuntime,
  type ServerLifecycleController,
} from "../src/server/index";

const temporaryDirectories: string[] = [];
const runningServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  // deadline 用例使用虚拟 timer；每例恢复，避免影响真实 loopback 宽限时间或后续构建测试。
  vi.useRealTimers();
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
  it("本机免登录旁路强制监听回环地址，普通运行仍保留容器监听范围", async () => {
    // 若未来把旁路误改回 0.0.0.0，此断言会阻止无认证管理 API 向局域网暴露；普通容器运行则必须继续由 Compose 端口映射控制。
    expect(resolveListenHostname(await createConfig({ localDevelopmentAuthBypass: true }), {}))
      .toBe("127.0.0.1");
    expect(resolveListenHostname(await createConfig(), {})).toBe("0.0.0.0");
  });
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

    // HTTP 单元只验证监听关闭；真实 SIGINT/SIGTERM 由下方进程协调测试覆盖，不能再由 startServer 直接订阅。
    void server.close();
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

describe("Node 进程级关停协调", () => {
  it("按调度停止、HTTP 关闭等待、调度空闲、数据库关闭顺序共享宽限总预算", async () => {
    // 模拟 HTTP 阶段消耗 60ms；调度器必须只收到剩余 40ms，而不是重新获得完整 100ms。
    const lifecycle = new TestProcessLifecycleController();
    const order: string[] = [];
    let now = 1_000;
    const httpFinished = createDeferred();
    const coordinated = coordinateServerShutdown({
      lifecycle,
      shutdownGraceMs: 100,
      nowMilliseconds: () => now,
      scheduler: {
        stop: () => {
          order.push("scheduler-stop");
        },
        waitForIdle: async (timeoutMs) => {
          order.push(`scheduler-idle:${timeoutMs}`);
          return false;
        },
      },
      http: {
        close: async () => {
          order.push("http-close");
          now += 60;
          httpFinished.resolve();
        },
        finished: async () => {
          await httpFinished.promise;
          order.push("http-finished");
        },
      },
      database: {
        close: async () => {
          order.push("database-close");
        },
      },
    });

    await lifecycle.subscribed;
    lifecycle.triggerShutdown();
    await coordinated;

    expect(order).toEqual([
      "scheduler-stop",
      "http-close",
      "http-finished",
      "scheduler-idle:40",
      "database-close",
    ]);
    expect(lifecycle.unsubscribeCount).toBe(1);
  });

  it("HTTP 自行结束时也进入同一关停链并清理进程信号订阅", async () => {
    // 底层 server error/close 可能先于 SIGTERM；若不竞速 finished，scheduler timer 会继续触碰已关闭服务或数据库。
    const lifecycle = new TestProcessLifecycleController();
    const order: string[] = [];
    const httpFinished = createDeferred();
    const coordinated = coordinateServerShutdown({
      lifecycle,
      shutdownGraceMs: 100,
      scheduler: {
        stop: () => order.push("scheduler-stop"),
        waitForIdle: async () => {
          order.push("scheduler-idle");
          return true;
        },
      },
      http: {
        close: async () => {
          order.push("http-close");
          httpFinished.resolve();
        },
        finished: () => httpFinished.promise,
      },
      database: {
        close: async () => {
          order.push("database-close");
        },
      },
    });
    await lifecycle.subscribed;

    httpFinished.resolve();
    await coordinated;

    expect(order).toEqual([
      "scheduler-stop",
      "http-close",
      "scheduler-idle",
      "database-close",
    ]);
    expect(lifecycle.unsubscribeCount).toBe(1);
  });

  it("按数据库迁移、依赖、HTTP、调度顺序启动并让进程信号进入统一关停链", async () => {
    // runtime 完全在内存中，不监听端口也不连接数据库；顺序断言防止真实信号绕过 scheduler stop 直接关闭 HTTP。
    const lifecycle = new TestProcessLifecycleController();
    const order: string[] = [];
    const database = createProcessDatabase(order);
    const httpFinished = createDeferred();
    const schedulerStarted = createDeferred();
    const runtime: ServerProcessRuntime = {
      createDatabase: () => {
        order.push("database-create");
        return database;
      },
      runMigrations: async () => {
        order.push("database-migrate");
      },
      createDependencies: () => {
        order.push("dependencies-create");
        return {
          http: { dispatchApi: async () => null },
          scheduler: {
            database,
            runMinute: async () => undefined,
            runSixHour: async () => undefined,
            recordSafeFailure: () => undefined,
          },
        };
      },
      startHttp: async () => {
        order.push("http-start");
        return {
          close: async () => {
            order.push("http-close");
            httpFinished.resolve();
          },
          finished: async () => {
            await httpFinished.promise;
            order.push("http-finished");
          },
        };
      },
      startScheduler: () => {
        order.push("scheduler-start");
        schedulerStarted.resolve();
        return {
          stop: () => {
            order.push("scheduler-stop");
          },
          waitForIdle: async () => {
            order.push("scheduler-idle");
            return true;
          },
        };
      },
    };

    const running = runServerProcess({
      DATABASE_URL: "postgres://example.invalid/process-test",
      COOKIE_SECURE: "false",
      STATIC_DIRECTORY: "/tmp/process-test-static-not-read",
      SHUTDOWN_GRACE_MS: "100",
    }, lifecycle, runtime);
    // 信号现在早于数据库订阅；启动顺序断言必须等待 scheduler 自己的栅栏，不能复用早期订阅 promise。
    await Promise.all([lifecycle.subscribed, schedulerStarted.promise]);
    expect(order).toEqual([
      "database-create",
      "database-migrate",
      "dependencies-create",
      "http-start",
      "scheduler-start",
    ]);

    lifecycle.triggerShutdown();
    await running;

    expect(order).toEqual([
      "database-create",
      "database-migrate",
      "dependencies-create",
      "http-start",
      "scheduler-start",
      "scheduler-stop",
      "http-close",
      "http-finished",
      "scheduler-idle",
      "database-close",
    ]);
  });

  it.each([
    {
      deferredStage: "migration" as const,
      elapsedAfterSignalMs: 40,
      expectedIdleBudgetMs: 60,
    },
    {
      deferredStage: "http-start" as const,
      elapsedAfterSignalMs: 150,
      expectedIdleBudgetMs: 0,
    },
  ])(
    "在 $deferredStage 延迟阶段锁存首次 shutdown，消耗 $elapsedAfterSignalMs ms 后只保留剩余总预算",
    async ({
      deferredStage,
      elapsedAfterSignalMs,
      expectedIdleBudgetMs,
    }) => {
      /**
       * 生命周期订阅必须早于数据库和迁移；测试在真实资源尚未齐备时只触发一次内存信号。
       * shutdownGraceMs 从首次信号而非 coordinate 启动计时，长迁移/HTTP 启动消耗后不得重新获得完整预算。
       */
      const result = await runDeferredStartupSignalCase(
        deferredStage,
        elapsedAfterSignalMs,
      );

      expect(result.subscribedBeforeDatabase).toBe(true);
      expect(result.order).toContain("scheduler-stop");
      expect(result.idleBudgetMs).toBe(expectedIdleBudgetMs);
      expect(result.order.at(-1)).toBe("database-close");
      expect(result.unsubscribeCount).toBe(1);
    },
  );

  it("HTTP close 与 finished 永不完成时仍在共享 deadline 后继续调度和数据库清理", async () => {
    // close 必须先被调用以停止接收请求，但其 promise 与 finished 都不可信，不能无限占用整个进程关停。
    vi.useFakeTimers();
    const lifecycle = new TestProcessLifecycleController();
    const order: string[] = [];
    let nowMilliseconds = 1_000;
    const never = new Promise<void>(() => undefined);
    const coordinated = coordinateServerShutdown({
      lifecycle,
      shutdownGraceMs: 100,
      nowMilliseconds: () => nowMilliseconds,
      scheduler: {
        stop: () => order.push("scheduler-stop"),
        waitForIdle: async (timeoutMs) => {
          order.push(`scheduler-idle:${timeoutMs}`);
          return false;
        },
      },
      http: {
        close: () => {
          order.push("http-close");
          return never;
        },
        finished: () => never,
      },
      database: {
        close: async () => {
          order.push("database-close");
        },
      },
    });
    const outcome = coordinated.then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await lifecycle.subscribed;
    lifecycle.triggerShutdown();
    // 只刷新 promise 微任务，确认 close 已启动且唯一共享 deadline timer 已注册，不依赖额外 0ms timer 顺序。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("http-close");
    nowMilliseconds = 1_100;
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcome).resolves.toContain("SERVER_SHUTDOWN_FAILED");
    expect(order).toEqual([
      "scheduler-stop",
      "http-close",
      "scheduler-idle:0",
      "database-close",
    ]);
  });

  it("HTTP close 与 finished 拒绝时不打印原异常且继续 idle 与数据库关闭", async () => {
    // 两个异常包含敏感 marker；协调器只能返回固定聚合错误，不能记录或让首个拒绝跳过后续清理。
    const lifecycle = new TestProcessLifecycleController();
    const order: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const coordinated = coordinateServerShutdown({
      lifecycle,
      shutdownGraceMs: 100,
      nowMilliseconds: () => 1_000,
      scheduler: {
        stop: () => order.push("scheduler-stop"),
        waitForIdle: async (timeoutMs) => {
          order.push(`scheduler-idle:${timeoutMs}`);
          return true;
        },
      },
      http: {
        close: async () => {
          order.push("http-close");
          throw new Error("postgres://sensitive-close.invalid/private");
        },
        finished: async () => {
          throw new Error("telegram-sensitive-finished-marker");
        },
      },
      database: {
        close: async () => {
          order.push("database-close");
        },
      },
    });
    await lifecycle.subscribed;
    lifecycle.triggerShutdown();

    try {
      const outcome = await coordinated.then(
        () => "resolved",
        (error: unknown) => String(error),
      );
      expect(outcome).toContain("SERVER_SHUTDOWN_FAILED");
      expect(outcome).not.toContain("sensitive-close");
      expect(outcome).not.toContain("telegram-sensitive");
      expect(order).toEqual([
        "scheduler-stop",
        "http-close",
        "scheduler-idle:100",
        "database-close",
      ]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("默认关停时钟不受 Date.now 墙钟回拨影响而延长总宽限", async () => {
    /**
     * 首次信号时墙钟为 1000，随后模拟 NTP/人工回拨到 500。
     * 默认实现必须使用 Node 单调时钟；若使用 Date.now，1100 的 deadline 会错误减去 500，得到 600ms。
     */
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const result = await runDeferredStartupSignalCase(
        "migration",
        0,
        {
          injectMonotonicClock: false,
          afterSignal: () => wallClock.mockReturnValue(500),
        },
      );

      expect(result.idleBudgetMs).toBeGreaterThanOrEqual(0);
      expect(result.idleBudgetMs).toBeLessThanOrEqual(100);
      expect(result.order.at(-1)).toBe("database-close");
    } finally {
      wallClock.mockRestore();
    }
  });
});

/** HTTP 测试观察器只记录临时端口并收窄 loopback，不拥有任何进程信号订阅。 */
class TestLifecycleController implements ServerLifecycleController {
  // 测试只在本机 loopback 创建临时监听，绝不暴露到局域网或与生产 Compose 端口竞争。
  public readonly listenHostname = "127.0.0.1";
  private resolvePort: ((port: number) => void) | undefined;
  public readonly listeningPort = new Promise<number>((resolve) => {
    this.resolvePort = resolve;
  });

  public onListening(port: number): void {
    this.resolvePort?.(port);
  }
}

/**
 * 进程测试控制器只保存协调器订阅的回调，并提供显式 subscribed 栅栏；
 * 触发和清理都发生在内存，绝不会向 Vitest/Codex 宿主发送 SIGINT 或 SIGTERM。
 */
class TestProcessLifecycleController implements ProcessLifecycleController {
  private shutdown: (() => void) | undefined;
  private markSubscribed: (() => void) | undefined;
  public unsubscribeCount = 0;
  public readonly subscribed = new Promise<void>((resolve) => {
    this.markSubscribed = resolve;
  });

  public subscribe(shutdown: () => void): () => void {
    this.shutdown = shutdown;
    this.markSubscribed?.();
    return () => {
      this.shutdown = undefined;
      this.unsubscribeCount += 1;
    };
  }

  public triggerShutdown(): void {
    this.shutdown?.();
  }

  public get hasSubscriber(): boolean {
    return this.shutdown !== undefined;
  }
}

/** 进程装配测试的数据库只允许最终 close；若启动或协调器越权执行 SQL/事务，立即以固定测试错误失败。 */
function createProcessDatabase(order: string[]): import("../src/server/database/types").AppDatabase {
  return {
    async query<Row>(): Promise<{ rows: Row[]; rowCount: number }> {
      throw new Error("进程装配测试不应执行 SQL");
    },
    async transaction<T>(): Promise<T> {
      throw new Error("进程装配测试不应打开事务");
    },
    async withAdvisoryLock<T>(): Promise<T | undefined> {
      throw new Error("进程装配测试不应获取锁");
    },
    async close(): Promise<void> {
      order.push("database-close");
    },
  };
}

/** HTTP finished 与 close 的真实关系由可控 promise 表达，避免测试把调用方法误当成底层连接已经关闭。 */
function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

/**
 * 运行 migration 或 HTTP start 延迟场景。第一次 shutdown 始终在 gate 释放前触发；
 * 若旧实现尚未订阅，测试只为避免留下悬挂 promise 而补发一次信号，最终断言仍会因订阅时刻错误而失败。
 */
async function runDeferredStartupSignalCase(
  deferredStage: "migration" | "http-start",
  elapsedAfterSignalMs: number,
  options: {
    injectMonotonicClock?: boolean;
    afterSignal?(): void;
  } = {},
): Promise<{
  subscribedBeforeDatabase: boolean;
  order: string[];
  idleBudgetMs: number | undefined;
  unsubscribeCount: number;
}> {
  const lifecycle = new TestProcessLifecycleController();
  const order: string[] = [];
  const stageGate = createDeferred();
  const stageStarted = createDeferred();
  const httpFinished = createDeferred();
  let subscribedBeforeDatabase = false;
  let nowMilliseconds = 1_000;
  let idleBudgetMs: number | undefined;
  const database = createProcessDatabase(order);
  const runtime: ServerProcessRuntime = {
    createDatabase: () => {
      subscribedBeforeDatabase = lifecycle.hasSubscriber;
      order.push("database-create");
      return database;
    },
    runMigrations: async () => {
      order.push("database-migrate");
      if (deferredStage === "migration") {
        stageStarted.resolve();
        await stageGate.promise;
      }
    },
    createDependencies: () => ({
      http: { dispatchApi: async () => null },
      scheduler: {
        database,
        runMinute: async () => undefined,
        runSixHour: async () => undefined,
        recordSafeFailure: () => undefined,
      },
    }),
    startHttp: async () => {
      order.push("http-start");
      if (deferredStage === "http-start") {
        stageStarted.resolve();
        await stageGate.promise;
      }
      return {
        close: async () => {
          order.push("http-close");
          httpFinished.resolve();
        },
        finished: () => httpFinished.promise,
      };
    },
    startScheduler: () => {
      order.push("scheduler-start");
      return {
        stop: () => order.push("scheduler-stop"),
        waitForIdle: async (timeoutMs) => {
          idleBudgetMs = timeoutMs;
          order.push("scheduler-idle");
          return true;
        },
      };
    },
    ...(options.injectMonotonicClock === false
      ? {}
      : {
        // 单调测试时钟只用于进程关停预算，不参与业务 scheduledAt 或管理员时区换算。
        nowMilliseconds: () => nowMilliseconds,
      }),
  };
  const running = runServerProcess({
    DATABASE_URL: "postgres://example.invalid/startup-signal-test",
    COOKIE_SECURE: "false",
    STATIC_DIRECTORY: "/tmp/startup-signal-static-not-read",
    SHUTDOWN_GRACE_MS: "100",
  }, lifecycle, runtime);

  await stageStarted.promise;
  lifecycle.triggerShutdown();
  options.afterSignal?.();
  nowMilliseconds += elapsedAfterSignalMs;
  stageGate.resolve();
  await lifecycle.subscribed;
  if (!subscribedBeforeDatabase) {
    // 仅帮助旧实现退出；它仍会因 subscribedBeforeDatabase=false 得到有效 RED。
    lifecycle.triggerShutdown();
  }
  await running;
  return {
    subscribedBeforeDatabase,
    order,
    idleBudgetMs,
    unsubscribeCount: lifecycle.unsubscribeCount,
  };
}

/** 每个用例创建隔离静态根和完整配置；数据库 URL 只是假值且 startServer 不连接数据库。 */
async function createConfig(
  overrides: Partial<Pick<ServerConfig, "shutdownGraceMs" | "localDevelopmentAuthBypass">> = {},
): Promise<ServerConfig> {
  const staticDirectory = await mkdtemp(join(tmpdir(), "switch-price-monitor-server-shutdown-"));
  temporaryDirectories.push(staticDirectory);
  await writeFile(join(staticDirectory, "index.html"), "<!doctype html><p>shutdown-test</p>");
  return {
    port: 0,
    databaseUrl: "postgres://example.invalid/not-used-by-start-server",
    cookieSecure: false,
    // 关停夹具不测试本机旁路；显式 false 防止未来 ServerConfig 新增默认行为让启动顺序测试意外失去认证边界。
    localDevelopmentAuthBypass: overrides.localDevelopmentAuthBypass ?? false,
    staticDirectory,
    maximumBodyBytes: 1024,
    shutdownGraceMs: overrides.shutdownGraceMs ?? 500,
  };
}

/** 让 server.close 的停止监听状态进入下一轮事件循环，再验证新连接确实被拒绝。 */
async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
