import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import {
  startScheduler,
  type SchedulerClock,
} from "../src/server/scheduler";
import { createServerDependencies } from "../src/server/dependencies";

afterEach(() => {
  // 默认时钟测试使用 Vitest 虚拟 Node timer；每例恢复真实计时，避免影响数据库或 HTTP 生命周期用例。
  vi.useRealTimers();
  // Telegram 外部边界只在单个装配用例内替换，结束后必须恢复真实全局 fetch，避免跨测试泄漏凭据夹具。
  vi.unstubAllGlobals();
});

describe("Node PostgreSQL 调度器", () => {
  it("把同一捕获的 UTC 分钟时刻交给锁内任务", async () => {
    // 这个用例防止回调在取得锁后重新读取本地时钟，导致日报判断与通知审计落在两个不同分钟。
    const clock = new FakeSchedulerClock();
    const database = new FakeAdvisoryLockDatabase();
    const runMinute = vi.fn<(scheduledAt: string) => Promise<void>>().mockResolvedValue();
    const scheduler = startScheduler({
      database,
      runMinute,
      runSixHour: async () => undefined,
      recordSafeFailure: () => undefined,
    }, clock);

    clock.triggerMinute(new Date("2026-07-28T06:07:00.000Z"));
    await scheduler.waitForIdle(100);

    expect(runMinute).toHaveBeenCalledExactlyOnceWith("2026-07-28T06:07:00.000Z");
    scheduler.stop();
  });

  it("分钟与六小时任务使用两个固定且不同的 signed bigint 锁键", async () => {
    // 固定字面值能防止后续重构误用迁移锁或让两类任务共享锁；两个值都在 PostgreSQL signed bigint 范围内。
    const clock = new FakeSchedulerClock();
    const database = new FakeAdvisoryLockDatabase();
    const scheduler = startScheduler({
      database,
      runMinute: async () => undefined,
      runSixHour: async () => undefined,
      recordSafeFailure: () => undefined,
    }, clock);

    clock.triggerMinute(new Date("2026-07-28T06:08:00.000Z"));
    clock.triggerSixHour(new Date("2026-07-28T06:00:00.000Z"));
    await scheduler.waitForIdle(100);

    expect(database.observedKeys).toEqual([8_602_727_101n, 8_602_727_102n]);
    expect(database.observedKeys[0]).not.toBe(database.observedKeys[1]);
    scheduler.stop();
  });

  it("锁被同实例上一轮占用时立即跳过重复触发且不排队补跑", async () => {
    // 第一轮保持未完成后再触发同一分钟；若实现使用阻塞锁或队列，释放后会错误执行第二次。
    const clock = new FakeSchedulerClock();
    const database = new FakeAdvisoryLockDatabase();
    const deferred = createDeferred();
    const runMinute = vi.fn<(scheduledAt: string) => Promise<void>>()
      .mockImplementation(async () => deferred.promise);
    const scheduler = startScheduler({
      database,
      runMinute,
      runSixHour: async () => undefined,
      recordSafeFailure: () => undefined,
    }, clock);

    clock.triggerMinute(new Date("2026-07-28T06:09:00.000Z"));
    await nextMicrotask();
    clock.triggerMinute(new Date("2026-07-28T06:10:00.000Z"));
    await nextMicrotask();
    expect(runMinute).toHaveBeenCalledExactlyOnceWith("2026-07-28T06:09:00.000Z");

    deferred.resolve();
    await scheduler.waitForIdle(100);
    expect(runMinute).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("任务异常只记录安全事件且后续触发仍可执行", async () => {
    // 原始异常故意携带看似敏感的 URL；失败出口只能看到任务种类和首次捕获的 UTC 时刻。
    const clock = new FakeSchedulerClock();
    const database = new FakeAdvisoryLockDatabase();
    const runMinute = vi.fn<(scheduledAt: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("postgres://secret.invalid/private"))
      .mockResolvedValueOnce();
    const recordSafeFailure = vi.fn();
    const scheduler = startScheduler({
      database,
      runMinute,
      runSixHour: async () => undefined,
      recordSafeFailure,
    }, clock);

    clock.triggerMinute(new Date("2026-07-28T06:11:00.000Z"));
    await scheduler.waitForIdle(100);
    clock.triggerMinute(new Date("2026-07-28T06:12:00.000Z"));
    await scheduler.waitForIdle(100);

    expect(recordSafeFailure).toHaveBeenCalledExactlyOnceWith({
      task: "minute",
      scheduledAt: "2026-07-28T06:11:00.000Z",
    });
    expect(runMinute).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("stop 幂等停止两个时钟且不再接收新工作", async () => {
    // stop 之后即使测试仍持有旧触发入口也不能创建任务，避免关停中的数据库池被新回调重新使用。
    const clock = new FakeSchedulerClock();
    const database = new FakeAdvisoryLockDatabase();
    const runMinute = vi.fn<(scheduledAt: string) => Promise<void>>().mockResolvedValue();
    const runSixHour = vi.fn<(scheduledAt: string) => Promise<void>>().mockResolvedValue();
    const scheduler = startScheduler({
      database,
      runMinute,
      runSixHour,
      recordSafeFailure: () => undefined,
    }, clock);

    scheduler.stop();
    scheduler.stop();
    clock.triggerMinute(new Date("2026-07-28T06:13:00.000Z"));
    clock.triggerSixHour(new Date("2026-07-28T12:00:00.000Z"));

    expect(clock.stopCounts).toEqual({ minute: 1, sixHour: 1 });
    expect(runMinute).not.toHaveBeenCalled();
    expect(runSixHour).not.toHaveBeenCalled();
  });

  it("waitForIdle 在任务完成时返回 true，在同一宽限超时时返回 false", async () => {
    // waitForIdle 只观察已接收工作，不取消事务；超时后释放任务仍应能再次观察到空闲。
    const clock = new FakeSchedulerClock();
    const database = new FakeAdvisoryLockDatabase();
    const deferred = createDeferred();
    const scheduler = startScheduler({
      database,
      runMinute: async () => deferred.promise,
      runSixHour: async () => undefined,
      recordSafeFailure: () => undefined,
    }, clock);

    expect(await scheduler.waitForIdle(0)).toBe(true);
    clock.triggerMinute(new Date("2026-07-28T06:14:00.000Z"));
    await nextMicrotask();
    expect(await scheduler.waitForIdle(5)).toBe(false);

    deferred.resolve();
    expect(await scheduler.waitForIdle(100)).toBe(true);
    scheduler.stop();
  });

  it("默认时钟对齐下一 UTC 分钟和 UTC 六小时整点并传递目标边界", async () => {
    // 11:59:59.900Z 的两个下一边界都是 12:00:00Z；回调必须传计划边界而非 timer 实际唤醒时重新取 now。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T11:59:59.900Z"));
    const database = new FakeAdvisoryLockDatabase();
    const runMinute = vi.fn<(scheduledAt: string) => Promise<void>>().mockResolvedValue();
    const runSixHour = vi.fn<(scheduledAt: string) => Promise<void>>().mockResolvedValue();
    const scheduler = startScheduler({
      database,
      runMinute,
      runSixHour,
      recordSafeFailure: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(100);
    await scheduler.waitForIdle(100);

    expect(runMinute).toHaveBeenCalledExactlyOnceWith("2026-07-28T12:00:00.000Z");
    expect(runSixHour).toHaveBeenCalledExactlyOnceWith("2026-07-28T12:00:00.000Z");
    scheduler.stop();
  });

  it("默认分钟时钟按目标 epoch 递归安排下一边界", async () => {
    // 连续两次必须恰好相差一分钟；若改为 setInterval 或按旧回调完成时间递推，延迟会逐轮累积。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T06:07:30.500Z"));
    const database = new FakeAdvisoryLockDatabase();
    const minuteInstants: string[] = [];
    const scheduler = startScheduler({
      database,
      runMinute: async (scheduledAt) => {
        minuteInstants.push(scheduledAt);
      },
      runSixHour: async () => undefined,
      recordSafeFailure: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(29_500);
    await scheduler.waitForIdle(100);
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.waitForIdle(100);

    expect(minuteInstants).toEqual([
      "2026-07-28T06:08:00.000Z",
      "2026-07-28T06:09:00.000Z",
    ]);
    scheduler.stop();
  });

  it("数据库任务和安全记录器同时异常也不会形成未处理 rejection", async () => {
    // 普通日志实现若意外失败，调度器仍不能让 promise rejection 逃出进程；后续 HTTP 与下一轮任务必须继续存活。
    const clock = new FakeSchedulerClock();
    const database = new FakeAdvisoryLockDatabase();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const scheduler = startScheduler({
      database,
      runMinute: async () => {
        throw new Error("外部任务失败正文不得传播");
      },
      runSixHour: async () => undefined,
      recordSafeFailure: () => {
        throw new Error("安全记录出口不可用");
      },
    }, clock);

    try {
      clock.triggerMinute(new Date("2026-07-28T06:15:00.000Z"));
      await scheduler.waitForIdle(100);
      await nextEventLoopTurn();
      expect(unhandled).toEqual([]);
    } finally {
      scheduler.stop();
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("Node 调度服务装配", () => {
  it("minute 用同一 ISO 执行日报与 pending 通知并只在 Telegram 成对配置时发送", async () => {
    // 使用真实 PostgreSQL 仓储和业务服务，只替换 SQL 与 Telegram 外部边界；消息正文和 delivered 参数独立证明两条路径收到同一时刻。
    const database = new SchedulerAssemblyDatabase();
    const telegramRequests: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      telegramRequests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const dependencies = createServerDependencies(database, {
      cookieSecure: false,
      telegramBotToken: "paired-test-token",
      telegramChatId: "paired-test-chat",
    });
    const scheduledAt = "2026-07-28T01:00:00.000Z";

    await dependencies.scheduler.runMinute(scheduledAt);

    expect(telegramRequests).toHaveLength(2);
    expect(telegramRequests.map((request) => request.body)).toContainEqual({
      chat_id: "paired-test-chat",
      text: expect.stringContaining("2026-07-28 09:00"),
      disable_web_page_preview: true,
    });
    expect(telegramRequests.map((request) => request.body)).toContainEqual({
      chat_id: "paired-test-chat",
      text: expect.stringContaining("采集恢复"),
      disable_web_page_preview: true,
    });
    expect(database.deliveredParameters).toEqual([
      scheduledAt,
      "product-jp:collection-recovered:1",
    ]);
  });

  it("six-hour 只执行一次既有保留与采集组合入口", async () => {
    // 空商品夹具仍会经过真实 RetentionService 与 LiveCollectionRunner，但不会访问外部价格或汇率网络。
    const database = new SchedulerAssemblyDatabase();
    const dependencies = createServerDependencies(database, {
      cookieSecure: false,
    });

    await dependencies.scheduler.runSixHour("2026-07-28T06:00:00.000Z");

    expect(database.fetchLogDeletionCount).toBe(1);
    expect(database.collectionReadCount).toBe(1);
    expect(database.pendingReadCount).toBe(0);
  });

  it("拒绝只装配一项 Telegram 凭据", () => {
    // readServerConfig 通常先保证成对，但装配函数也是独立导出边界，不能让测试或未来调用者构造半配置 Telegram URL。
    expect(() => createServerDependencies(
      new SchedulerAssemblyDatabase(),
      {
        cookieSecure: false,
        telegramBotToken: "token-without-chat",
      },
    )).toThrow("SCHEDULER_TELEGRAM_CREDENTIALS_INCOMPLETE");
  });

  it("minute 一路立即失败时仍持锁等待另一路完成并跳过重复触发", async () => {
    /**
     * 日报设置读取立即失败，pending Telegram 投递保持未完成；锁必须覆盖两条 promise 的最终 settle。
     * 若装配使用提前拒绝的 Promise.all，第二次触发会在 pending 尚未结束时重新取得锁并重复发送。
     */
    const clock = new FakeSchedulerClock();
    const database = new EarlyRejectingMinuteDatabase();
    const delivery = createResponseDeferred();
    const fetcher = vi.fn<typeof fetch>(async () => delivery.promise);
    vi.stubGlobal("fetch", fetcher);
    const assembled = createServerDependencies(database, {
      cookieSecure: false,
      telegramBotToken: "paired-test-token",
      telegramChatId: "paired-test-chat",
    });
    const recordSafeFailure = vi.fn();
    const scheduler = startScheduler({
      ...assembled.scheduler,
      recordSafeFailure,
    }, clock);

    clock.triggerMinute(new Date("2026-07-28T01:01:00.000Z"));
    await nextEventLoopTurn();
    expect(database.lockActive).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock.triggerMinute(new Date("2026-07-28T01:02:00.000Z"));
    await nextEventLoopTurn();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(database.acquiredCount).toBe(1);

    delivery.resolve(new Response("{}", { status: 200 }));
    await scheduler.waitForIdle(100);
    expect(database.lockActive).toBe(false);
    expect(recordSafeFailure).toHaveBeenCalledExactlyOnceWith({
      task: "minute",
      scheduledAt: "2026-07-28T01:01:00.000Z",
    });
    scheduler.stop();
  });
});

/**
 * 假时钟只保存生产调度器注册的回调，让测试用字面 UTC 时间主动触发；
 * 它不模拟 Node timer 实现细节，也不会读取测试进程的本地时区。
 */
class FakeSchedulerClock implements SchedulerClock {
  private minuteCallback: ((scheduledAt: Date) => void) | undefined;
  private sixHourCallback: ((scheduledAt: Date) => void) | undefined;
  public readonly stopCounts = { minute: 0, sixHour: 0 };

  public everyMinute(callback: (scheduledAt: Date) => void): { stop(): void } {
    this.minuteCallback = callback;
    return {
      stop: () => {
        this.stopCounts.minute += 1;
        this.minuteCallback = undefined;
      },
    };
  }

  public everySixHours(callback: (scheduledAt: Date) => void): { stop(): void } {
    this.sixHourCallback = callback;
    return {
      stop: () => {
        this.stopCounts.sixHour += 1;
        this.sixHourCallback = undefined;
      },
    };
  }

  public triggerMinute(scheduledAt: Date): void {
    this.minuteCallback?.(scheduledAt);
  }

  public triggerSixHour(scheduledAt: Date): void {
    this.sixHourCallback?.(scheduledAt);
  }
}

/**
 * 首个 RED 只需证明任务确实经过 advisory-lock 回调；事务和 SQL 在本用例不可达，
 * 若调度器越权调用这些能力便立即抛出固定测试错误。
 */
class FakeAdvisoryLockDatabase implements AppDatabase {
  public readonly observedKeys: bigint[] = [];
  private readonly activeKeys = new Set<bigint>();

  public async withAdvisoryLock<T>(
    key: bigint,
    work: (connection: SqlExecutor) => Promise<T>,
  ): Promise<T | undefined> {
    this.observedKeys.push(key);
    if (this.activeKeys.has(key)) return undefined;
    this.activeKeys.add(key);
    try {
      return await work(this);
    } finally {
      this.activeKeys.delete(key);
    }
  }

  public async query<Row>(): Promise<{ rows: Row[]; rowCount: number }> {
    throw new Error("测试调度器不应直接执行 SQL");
  }

  public async transaction<T>(): Promise<T> {
    throw new Error("测试调度器不应打开事务");
  }

  public async close(): Promise<void> {
    throw new Error("测试调度器不应关闭数据库");
  }
}

/**
 * 装配测试数据库只模拟已审计 SQL 的完整返回形状，并记录消费者可观察副作用；
 * 未识别 SQL 立即失败，防止仓储新增读写后测试仍以空结果静默通过。
 */
class SchedulerAssemblyDatabase implements AppDatabase {
  public deliveredParameters: readonly unknown[] | undefined;
  public fetchLogDeletionCount = 0;
  public collectionReadCount = 0;
  public pendingReadCount = 0;

  public async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    if (sql.includes("FROM settings")) {
      return {
        rows: [{
          enabledRegions: ["US", "JP"],
          defaultSearchRegion: "US",
          theme: "warm-card",
          timezone: "Asia/Shanghai",
          dailyReportTime: "09:00",
          taxState: "OR",
          priceHistoryRetention: "forever",
          createdAt: new Date("2026-07-28T00:00:00.000Z"),
        } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM notification_events") && sql.includes("status = 'pending'")) {
      this.pendingReadCount += 1;
      return {
        rows: [{
          regionalProductId: "product-jp",
          eventType: "collection-recovered",
          dedupeKey: "product-jp:collection-recovered:1",
          createdAt: new Date("2026-07-28T00:59:00.000Z"),
          gameNameZh: "胡闹厨房 2",
          regionCode: "JP",
        } as Row],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE notification_events")) {
      this.deliveredParameters = parameters;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM fetch_logs")) {
      this.fetchLogDeletionCount += 1;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM subscriptions") && sql.includes("products.enabled IS TRUE")) {
      this.collectionReadCount += 1;
      return { rows: [], rowCount: 0 };
    }
    // 仪表盘日报的三个聚合查询均以空订阅返回；日报仍生成“暂无启用订阅”的真实 Telegram 文本。
    if (
      sql.includes("FROM subscriptions")
      || sql.includes("FROM subscription_regions")
      || sql.includes("WITH ranked_lows")
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error("装配测试遇到未声明 SQL");
  }

  public async withAdvisoryLock<T>(
    _key: bigint,
    work: (connection: SqlExecutor) => Promise<T>,
  ): Promise<T | undefined> {
    return work(this);
  }

  public async transaction<T>(): Promise<T> {
    throw new Error("调度服务装配测试不应打开事务");
  }

  public async close(): Promise<void> {
    throw new Error("调度服务装配测试不应关闭数据库");
  }
}

/**
 * 专门复现分钟双路径竞态：日报的 settings SQL 立即失败，pending 查询成功并进入可控 Telegram 网络等待。
 * advisory lock 采用非阻塞语义，计数只增加真实取得锁的轮次，便于证明重复触发被跳过。
 */
class EarlyRejectingMinuteDatabase implements AppDatabase {
  public lockActive = false;
  public acquiredCount = 0;

  public async query<Row>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    if (sql.includes("FROM settings")) {
      throw new Error("postgres://sensitive.example.invalid/must-not-escape");
    }
    if (sql.includes("FROM notification_events") && sql.includes("status = 'pending'")) {
      return {
        rows: [{
          regionalProductId: "product-us",
          eventType: "collection-failure",
          dedupeKey: "product-us:collection-failure:lock-test",
          createdAt: new Date("2026-07-28T01:00:00.000Z"),
          gameNameZh: "胡闹厨房 2",
          regionCode: "US",
        } as Row],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE notification_events")) {
      return { rows: [], rowCount: parameters.length === 2 ? 1 : 0 };
    }
    throw new Error("锁生命周期测试遇到未声明 SQL");
  }

  public async withAdvisoryLock<T>(
    _key: bigint,
    work: (connection: SqlExecutor) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.lockActive) return undefined;
    this.lockActive = true;
    this.acquiredCount += 1;
    try {
      return await work(this);
    } finally {
      this.lockActive = false;
    }
  }

  public async transaction<T>(): Promise<T> {
    throw new Error("锁生命周期测试不应打开事务");
  }

  public async close(): Promise<void> {
    throw new Error("锁生命周期测试不应关闭数据库");
  }
}

/** 可控 promise 让测试制造真实重叠与宽限超时，不用 sleep 猜测任务完成时机。 */
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

/** Telegram 网络 deferred 使用完整 Response 类型，避免用不完整 mock 掩盖发送服务对 status/ok 的真实读取。 */
function createResponseDeferred(): {
  promise: Promise<Response>;
  resolve(value: Response): void;
} {
  let resolvePromise: ((value: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

/** advisory-lock 获取在 async 边界内发生；推进微任务即可观察，无需依赖宿主 timer 精度。 */
async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** 未处理 rejection 要到事件循环下一阶段才会发出；推进一轮后才能证明调度器已经吸收异常。 */
async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
