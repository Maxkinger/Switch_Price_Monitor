import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServerApp, type ServerDependencies } from "./app";
import { readServerConfig, type ServerConfig } from "./config";
import { createPostgresDatabase } from "./database/pool";
import { runMigrations } from "./database/migrations";
import { createServerDependencies } from "./dependencies";

/** 对外生命周期只允许幂等关闭和等待完全停止；底层 socket、Node Server 与进程对象不会泄漏给业务层。 */
export interface RunningServer {
  close(): Promise<void>;
  finished(): Promise<void>;
}

/**
 * 生命周期控制器抽象真实 SIGTERM/SIGINT，使测试可在内存触发关停且不用向 Codex/测试进程发送信号。
 * onListening 只返回实际端口，不包含主机网络、请求或任何运行时秘密。
 */
export interface ServerLifecycleController {
  subscribe(shutdown: () => void): () => void;
  onListening?(port: number): void;
  /**
   * 只供隔离测试把临时监听收窄到 loopback；生产控制器不设置此值，始终监听容器需要的 0.0.0.0。
   * 该字段不能来自请求头或环境变量，避免客户端改变服务暴露面。
   */
  readonly listenHostname?: string;
}

const processLifecycleController: ServerLifecycleController = {
  subscribe(shutdown) {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    };
  },
};

/**
 * 在 Node HTTP 上监听标准 Fetch 应用。close 先调用 server.close 停止新连接，再等待在途请求；
 * 超过 shutdownGraceMs 后仅强制关闭本服务连接，确保容器可退出而不触碰数据库或其它进程资源。
 */
export async function startServer(
  config: ServerConfig,
  dependencies: ServerDependencies,
  lifecycle: ServerLifecycleController = processLifecycleController,
): Promise<RunningServer> {
  const app = createServerApp(config, dependencies);
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  await listen(server, config.port, lifecycle.listenHostname ?? "0.0.0.0");
  const address = server.address() as AddressInfo | null;
  if (!address) {
    // 监听回调后仍无地址属于 Node 生命周期异常；固定错误不含 URL、环境或数据库连接信息。
    throw new Error("SERVER_ADDRESS_UNAVAILABLE");
  }
  lifecycle.onListening?.(address.port);

  let removeLifecycleListeners: () => void = () => undefined;
  let closePromise: Promise<void> | undefined;
  let resolveFinished: (() => void) | undefined;
  const finishedPromise = new Promise<void>((resolveFinishedPromise) => {
    resolveFinished = resolveFinishedPromise;
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = new Promise<void>((resolveClose, rejectClose) => {
      const graceTimer = setTimeout(() => {
        /**
         * server.closeAllConnections 只作用于当前 HTTP server；不关闭数据库池或外部客户端。
         * 强制阶段不等待永不完成的业务 promise，数据库由进程入口在 finished 之后统一关闭。
         */
        server.closeAllConnections();
      }, config.shutdownGraceMs);
      graceTimer.unref();

      server.close((error) => {
        clearTimeout(graceTimer);
        removeLifecycleListeners();
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    return closePromise;
  };

  server.once("close", () => {
    removeLifecycleListeners();
    resolveFinished?.();
  });
  // 监听后的底层异常不能包含在普通日志；先受控关停，固定进程级错误处理只输出安全摘要。
  server.on("error", () => {
    void close().catch(() => undefined);
  });
  removeLifecycleListeners = lifecycle.subscribe(() => {
    void close().catch(() => undefined);
  });

  return {
    close,
    finished: () => finishedPromise,
  };
}

/** 监听启动错误通过 promise 返回；调用方在成功前不会注册信号或报告临时端口。 */
async function listen(server: Server, port: number, hostname: string): Promise<void> {
  await new Promise<void>((resolveListening, rejectListening) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListening(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListening();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // 生产监听所有容器接口；实际 NAS 暴露范围由 Compose 唯一 HTTP 端口映射控制。
    server.listen(port, hostname);
  });
}

/**
 * 进程入口按“配置校验 → 数据库 → 迁移 → HTTP”顺序启动，并在 HTTP 完全停止后关闭数据库。
 * catch 只打印固定摘要，不把原始数据库 URL、Telegram 凭据、SQL 或外部错误正文写入普通日志。
 */
async function runServerProcess(): Promise<void> {
  const config = readServerConfig(process.env);
  const database = createPostgresDatabase(config.databaseUrl);
  try {
    await runMigrations(database, resolve("migrations/postgres"));
    const running = await startServer(
      config,
      createServerDependencies(database, config),
    );
    await running.finished();
  } finally {
    await database.close();
  }
}

/** 仅直接执行构建入口时启动；测试导入 startServer 不应连接数据库、注册真实信号或监听端口。 */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  void runServerProcess().catch(() => {
    console.error("Node 服务启动或运行失败。");
    process.exitCode = 1;
  });
}
