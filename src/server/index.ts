import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createServerApp, type ServerDependencies } from "./app";
import { readServerConfig, type ServerConfig } from "./config";
import { createPostgresDatabase } from "./database/pool";
import { runMigrations } from "./database/migrations";
import type { AppDatabase } from "./database/types";
import { ensureLocalDevelopmentSetup } from "./local-development-setup";
import {
  createServerDependencies,
  type NodeServerDependencies,
} from "./dependencies";
import { startScheduler, type SchedulerHandle } from "./scheduler";

/** 对外生命周期只允许幂等关闭和等待完全停止；底层 socket、Node Server 与进程对象不会泄漏给业务层。 */
export interface RunningServer {
  close(): Promise<void>;
  finished(): Promise<void>;
}

/** 进程信号订阅只负责请求关停并返回清理函数；测试实现不得向真实进程发送任何信号。 */
export interface ProcessLifecycleController {
  subscribe(shutdown: () => void): () => void;
}

/** 首次 shutdown 请求会永久锁存在 promise 中；unsubscribe 幂等移除真实信号监听但不会清除已锁存状态。 */
interface ProcessShutdownSubscription {
  requested: Promise<void>;
  requestedDeadline(): number | undefined;
  unsubscribe(): void;
}

/**
 * HTTP 监听观察器只允许测试收窄 loopback 并取得临时端口；它不再订阅任何进程信号，
 * 因而真实 SIGTERM/SIGINT 只能进入上方进程协调器。onListening 不包含请求或运行时秘密。
 */
export interface ServerLifecycleController {
  onListening?(port: number): void;
  /**
   * 只供隔离测试把临时监听收窄到 loopback；生产控制器不设置此值，始终监听容器需要的 0.0.0.0。
   * 该字段不能来自请求头或环境变量，避免客户端改变服务暴露面。
   */
  readonly listenHostname?: string;
}

/** 进程协调器只取得数据库关闭能力，不能在关停阶段重新执行 SQL、事务或 advisory lock。 */
interface ClosableDatabase {
  close(): Promise<void>;
}

/** 关停协调输入显式列出资源所有权、唯一总预算和可注入单调观察点，不读取环境变量或秘密。 */
export interface ServerShutdownCoordination {
  lifecycle?: ProcessLifecycleController;
  shutdownSubscription?: ProcessShutdownSubscription;
  shutdownGraceMs: number;
  scheduler: SchedulerHandle;
  http: RunningServer;
  database: ClosableDatabase;
  nowMilliseconds?: () => number;
}

const processLifecycleController: ProcessLifecycleController = {
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
 * 进程关停预算必须使用 Node 单调时钟，避免 NTP 同步、管理员校时或时区变化让墙钟回拨后延长 grace。
 * 该函数只计算相对生命周期，不生成业务 scheduledAt，也不参与管理员 IANA 时区判断。
 */
const monotonicNowMilliseconds = (): number => performance.now();

/**
 * 在数据库或迁移启动前建立单一信号订阅。Promise resolve 天然幂等并锁存首次请求，
 * 即使 HTTP/scheduler 尚未出现，后续协调器也会在资源构造完成后立即进入同一清理链。
 */
function subscribeProcessShutdown(
  lifecycle: ProcessLifecycleController,
  nowMilliseconds: () => number,
  shutdownGraceMs: number,
): ProcessShutdownSubscription {
  let requestShutdown: (() => void) | undefined;
  let deadline: number | undefined;
  let unsubscribed = false;
  const requested = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });
  const removeListener = lifecycle.subscribe(() => {
    if (deadline !== undefined) return;
    // 只在首次 shutdown 锁存绝对截止点；后续信号不得重置或延长进程总宽限。
    deadline = nowMilliseconds() + shutdownGraceMs;
    requestShutdown?.();
  });
  return {
    requested,
    requestedDeadline: () => deadline,
    unsubscribe(): void {
      if (unsubscribed) return;
      unsubscribed = true;
      removeListener();
    },
  };
}

/**
 * 进程运行时把真实资源创建函数集中为可注入边界；测试只提供内存替身，
 * 生产默认值则不会把环境对象、数据库 URL 或 Telegram 凭据传给日志与调度失败出口。
 */
export interface ServerProcessRuntime {
  createDatabase(connectionString: string): AppDatabase;
  runMigrations(database: AppDatabase): Promise<void>;
  createDependencies(
    database: AppDatabase,
    config: ServerConfig,
  ): NodeServerDependencies;
  startHttp(
    config: ServerConfig,
    dependencies: ServerDependencies,
  ): Promise<RunningServer>;
  startScheduler(
    dependencies: NodeServerDependencies["scheduler"],
  ): SchedulerHandle;
  /** 单调时钟只计算进程关停预算；不能传入业务任务或替代 scheduler 的 UTC scheduledAt。 */
  nowMilliseconds?(): number;
}

const productionServerProcessRuntime: ServerProcessRuntime = {
  createDatabase: createPostgresDatabase,
  runMigrations: (database) => runMigrations(
    database,
    resolve("migrations/postgres"),
  ),
  createDependencies: createServerDependencies,
  startHttp: (config, dependencies) => startServer(config, dependencies),
  startScheduler,
};

/**
 * 订阅一次进程关停请求，并严格按 scheduler stop → HTTP close/wait → scheduler idle → DB close 执行。
 * 所有等待共享从首次请求起计算的 shutdownGraceMs；任一阶段失败仍继续释放后续资源，
 * 最终仅抛固定聚合错误，直接入口不会打印其中可能携带外部上下文的 cause。
 */
export async function coordinateServerShutdown(
  input: ServerShutdownCoordination,
): Promise<void> {
  const nowMilliseconds = input.nowMilliseconds ?? monotonicNowMilliseconds;
  const shutdownSubscription = input.shutdownSubscription
    ?? (input.lifecycle
      ? subscribeProcessShutdown(
        input.lifecycle,
        nowMilliseconds,
        input.shutdownGraceMs,
      )
      : undefined);
  if (!shutdownSubscription) {
    throw new Error("SERVER_SHUTDOWN_SUBSCRIPTION_REQUIRED");
  }
  /**
   * HTTP 可能因底层 server error 自行结束；立即取得 promise 并把 rejection 转为值，
   * 既可与信号竞速，也不会在正式清理读取结果前产生未处理 rejection。
   */
  const observedHttpFinished = observeShutdownOperation(
    () => input.http.finished(),
  );
  await Promise.race([
    shutdownSubscription.requested,
    observedHttpFinished.then(() => undefined),
  ]);
  // 早期信号已消耗迁移/HTTP 启动时间；只有 HTTP 自行结束且从未收到信号时才从当前时刻创建预算。
  const deadline = shutdownSubscription.requestedDeadline()
    ?? nowMilliseconds() + input.shutdownGraceMs;
  const failures: unknown[] = [];

  // 先清理信号监听并停止 timer，重复 SIGINT/SIGTERM 不能创建第二套并行关停流程。
  shutdownSubscription.unsubscribe();
  try {
    input.scheduler.stop();
  } catch {
    failures.push(new Error("SERVER_SCHEDULER_STOP_FAILED"));
  }
  const observedHttpClose = observeShutdownOperation(() => input.http.close());
  await waitForHttpShutdown(
    observedHttpClose,
    observedHttpFinished,
    deadline,
    nowMilliseconds,
    failures,
  );
  const remaining = Math.max(0, deadline - nowMilliseconds());
  await captureSafeShutdownFailure(
    () => input.scheduler.waitForIdle(remaining).then(() => undefined),
    failures,
    "SERVER_SCHEDULER_IDLE_FAILED",
  );
  await captureSafeShutdownFailure(
    () => input.database.close(),
    failures,
    "SERVER_DATABASE_CLOSE_FAILED",
  );

  if (failures.length > 0) {
    throw new AggregateError(failures, "SERVER_SHUTDOWN_FAILED");
  }
}

/** 将可能同步抛错或异步拒绝的资源操作立即转换为已观察结果，杜绝等待 deadline 前的 unhandled rejection。 */
function observeShutdownOperation(
  operation: () => Promise<void>,
): Promise<{ completed: true } | { completed: false }> {
  return Promise.resolve()
    .then(operation)
    .then(
      () => ({ completed: true as const }),
      () => ({ completed: false as const }),
    );
}

/**
 * close 与 finished 在同一个共享 deadline 内并行观察：close 先被启动以停止新请求，finished 代表在途等待。
 * 两者拒绝分别转换固定分类；任一或全部永不 settle 时只由一个 timer 截止，随后继续 scheduler 与 DB 清理。
 */
async function waitForHttpShutdown(
  close: Promise<{ completed: true } | { completed: false }>,
  finished: Promise<{ completed: true } | { completed: false }>,
  deadline: number,
  nowMilliseconds: () => number,
  failures: unknown[],
): Promise<void> {
  const remaining = Math.max(0, deadline - nowMilliseconds());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), remaining);
    timeout.unref();
  });
  const httpSettled = Promise.all([close, finished]);
  const result = await Promise.race([httpSettled, expired]);
  if (timeout) clearTimeout(timeout);
  if (result === "timeout") {
    failures.push(new Error("SERVER_HTTP_SHUTDOWN_TIMEOUT"));
    return;
  }
  if (!result[0].completed) failures.push(new Error("SERVER_HTTP_CLOSE_FAILED"));
  if (!result[1].completed) failures.push(new Error("SERVER_HTTP_FINISHED_FAILED"));
}

/** 协调阶段的非 HTTP 失败同样只保留固定分类，不让原始 Error 越过进程安全边界。 */
async function captureSafeShutdownFailure(
  operation: () => Promise<void>,
  failures: unknown[],
  failureCode: string,
): Promise<void> {
  try {
    await operation();
  } catch {
    failures.push(new Error(failureCode));
  }
}

/** 单阶段失败不能越过后续资源清理；错误只保存在最终 cause 中，不在此处输出或序列化。 */
async function captureShutdownFailure(
  operation: () => Promise<void>,
  failures: unknown[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

/**
 * 在 Node HTTP 上监听标准 Fetch 应用。close 先调用 server.close 停止新连接，再等待在途请求；
 * 超过 shutdownGraceMs 后仅强制关闭本服务连接，确保容器可退出而不触碰数据库或其它进程资源。
 */
export async function startServer(
  config: ServerConfig,
  dependencies: ServerDependencies,
  lifecycle: ServerLifecycleController = {},
): Promise<RunningServer> {
  const app = createServerApp(config, dependencies);
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  await listen(server, config.port, resolveListenHostname(config, lifecycle));
  const address = server.address() as AddressInfo | null;
  if (!address) {
    // 监听回调后仍无地址属于 Node 生命周期异常；固定错误不含 URL、环境或数据库连接信息。
    throw new Error("SERVER_ADDRESS_UNAVAILABLE");
  }
  lifecycle.onListening?.(address.port);

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
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    return closePromise;
  };

  server.once("close", () => {
    resolveFinished?.();
  });
  // 监听后的底层异常不能包含在普通日志；先受控关停，固定进程级错误处理只输出安全摘要。
  server.on("error", () => {
    void close().catch(() => undefined);
  });

  return {
    close,
    finished: () => finishedPromise,
  };
}

/**
 * 免登录旁路拥有比测试观察器更高的监听收窄优先级：即使误传了全接口地址，也只能监听本机回环。
 * 旁路关闭时保留生产容器的 0.0.0.0 与测试注入地址，避免把 Docker 服务误收窄后导致 Compose 健康检查失效。
 */
export function resolveListenHostname(
  config: Pick<ServerConfig, "localDevelopmentAuthBypass">,
  lifecycle: ServerLifecycleController,
): string {
  if (config.localDevelopmentAuthBypass) return "127.0.0.1";
  return lifecycle.listenHostname ?? "0.0.0.0";
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
 * 进程入口按“配置校验 → 数据库 → 迁移 → 可选本机默认设置 → 依赖 → HTTP → scheduler”顺序启动，
 * 并在统一协调器完成 HTTP 与调度等待后关闭数据库。
 * catch 只打印固定摘要，不把原始数据库 URL、Telegram 凭据、SQL 或外部错误正文写入普通日志。
 */
export async function runServerProcess(
  environment: NodeJS.ProcessEnv,
  lifecycle: ProcessLifecycleController = processLifecycleController,
  runtime: ServerProcessRuntime = productionServerProcessRuntime,
): Promise<void> {
  // 配置必须在任何连接、监听或信号订阅之前完整校验，非法秘密组合不能留下半启动资源。
  const config = readServerConfig(environment);
  const nowMilliseconds = runtime.nowMilliseconds ?? monotonicNowMilliseconds;
  // 配置通过后立刻订阅并锁存信号；数据库、迁移和 HTTP 的任何延迟都不能丢失首次 shutdown。
  const shutdownSubscription = subscribeProcessShutdown(
    lifecycle,
    nowMilliseconds,
    config.shutdownGraceMs,
  );
  let database: AppDatabase | undefined;
  let http: RunningServer | undefined;
  let coordinationStarted = false;
  try {
    database = runtime.createDatabase(config.databaseUrl);
    await runtime.runMigrations(database);
    // 默认设置必须在路由、HTTP 与调度装配前就绪；旁路关闭时函数严格无副作用，生产首次初始化仍由认证服务事务负责。
    await ensureLocalDevelopmentSetup(
      database,
      config.localDevelopmentAuthBypass,
      new Date().toISOString(),
    );
    const dependencies = runtime.createDependencies(database, config);
    http = await runtime.startHttp(config, dependencies.http);
    const scheduler = runtime.startScheduler(dependencies.scheduler);
    coordinationStarted = true;
    await coordinateServerShutdown({
      lifecycle,
      shutdownGraceMs: config.shutdownGraceMs,
      scheduler,
      http,
      database,
      shutdownSubscription,
      nowMilliseconds,
    });
  } catch (error) {
    if (coordinationStarted) throw error;
    /**
     * 进程信号已在数据库前注册；启动失败时先取消该早期订阅，若 HTTP 已出现则关闭并等待，
     * 再关闭数据库。清理错误与原始启动错误聚合但不在这里打印，外层只输出固定摘要。
     */
    const failures: unknown[] = [error];
    shutdownSubscription.unsubscribe();
    if (http) {
      await captureShutdownFailure(() => http?.close() ?? Promise.resolve(), failures);
      await captureShutdownFailure(() => http?.finished() ?? Promise.resolve(), failures);
    }
    if (database) {
      await captureShutdownFailure(() => database?.close() ?? Promise.resolve(), failures);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "SERVER_STARTUP_FAILED");
  }
}

/** 仅直接执行构建入口时启动；测试导入 startServer 不应连接数据库、注册真实信号或监听端口。 */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  void runServerProcess(process.env).catch(() => {
    console.error("Node 服务启动或运行失败。");
    process.exitCode = 1;
  });
}
