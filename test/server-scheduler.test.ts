import { describe, expect, it, vi } from "vitest";

import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import { startScheduler, type SchedulerClock } from "../src/server/scheduler";

/** 使用内存触发器模拟 Node 定时器；测试不等待真实分钟或六小时，避免时间流逝造成偶发竞态。 */
function fakeClock(): SchedulerClock & { triggerMinute(at: Date): void; triggerSixHour(at: Date): void } {
  let minute: ((at: Date) => void) | undefined;
  let sixHour: ((at: Date) => void) | undefined;
  return {
    everyMinute(callback) { minute = callback; return { stop: vi.fn() }; },
    everySixHours(callback) { sixHour = callback; return { stop: vi.fn() }; },
    triggerMinute(at) { minute?.(at); },
    triggerSixHour(at) { sixHour?.(at); },
  };
}

function databaseWithLock(lock: (key: bigint, work: () => Promise<void>) => Promise<void | undefined>): AppDatabase {
  const executor: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };
  return {
    query: executor.query,
    transaction: async <T>(work: (connection: SqlExecutor) => Promise<T>) => work(executor),
    withAdvisoryLock: async <T>(key: bigint, work: (connection: SqlExecutor) => Promise<T>) => {
      // 测试锁桩必须保留泛型回调返回值，才能与真实 AppDatabase 契约一致，而不是把“未获取锁”伪造成任意任务结果。
      let result: T | undefined;
      const acquired = await lock(key, async () => { result = await work(executor); });
      return acquired === undefined ? undefined : result;
    },
    close: async () => undefined,
  };
}

describe("PostgreSQL advisory-locked scheduler", () => {
  it("runs minute and six-hour work with one captured UTC instant", async () => {
    // 调度器只把触发时刻转换一次 ISO UTC；日报时区判断和采集快照都不能各自读取漂移的系统时间。
    const clock = fakeClock();
    const runMinute = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
    const runSixHour = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
    const scheduler = startScheduler({ database: databaseWithLock(async (_key, work) => work()), runMinute, runSixHour, recordSafeFailure: vi.fn() }, clock);

    clock.triggerMinute(new Date("2026-08-04T01:02:03.000Z"));
    clock.triggerSixHour(new Date("2026-08-04T06:00:00.000Z"));
    await scheduler.waitForIdle(100);

    expect(runMinute).toHaveBeenCalledExactlyOnceWith("2026-08-04T01:02:03.000Z");
    expect(runSixHour).toHaveBeenCalledExactlyOnceWith("2026-08-04T06:00:00.000Z");
  });

  it("skips a duplicate trigger while the advisory lock is held", async () => {
    // 第二次触发只能立即放弃，不能排队等待第一轮；这样多进程 NAS 部署不会积累重复日报或重复采集。
    const clock = fakeClock();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let lockCalls = 0;
    const runMinute = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
    const scheduler = startScheduler({
      database: databaseWithLock(async (_key, work) => {
        lockCalls += 1;
        if (lockCalls === 1) return work();
        return undefined;
      }),
      runMinute: async (at) => { runMinute(at); await held; },
      runSixHour: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
      recordSafeFailure: vi.fn(),
    }, clock);

    clock.triggerMinute(new Date("2026-08-04T01:00:00.000Z"));
    await Promise.resolve();
    clock.triggerMinute(new Date("2026-08-04T01:00:01.000Z"));
    await Promise.resolve();
    release();
    await scheduler.waitForIdle(100);

    expect(runMinute).toHaveBeenCalledExactlyOnceWith("2026-08-04T01:00:00.000Z");
  });

  it("records failures without stopping later triggers and waits for active work", async () => {
    // 一轮异常只进入脱敏记录回调，调度器本身继续接收后续触发；stop 后不再启动新工作，但 waitForIdle 会等待已启动任务。
    const clock = fakeClock();
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const runMinute = vi.fn<(_: string) => Promise<void>>().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    const recordSafeFailure = vi.fn();
    const scheduler = startScheduler({
      database: databaseWithLock(async (_key, work) => work()),
      runMinute,
      runSixHour: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
      recordSafeFailure,
    }, clock);

    clock.triggerMinute(new Date("2026-08-04T01:00:00.000Z"));
    await Promise.resolve();
    rejectFirst(new Error("内部测试故障"));
    await scheduler.waitForIdle(100);
    clock.triggerMinute(new Date("2026-08-04T01:01:00.000Z"));
    await scheduler.waitForIdle(100);
    scheduler.stop();
    clock.triggerMinute(new Date("2026-08-04T01:02:00.000Z"));
    await scheduler.waitForIdle(100);

    expect(recordSafeFailure).toHaveBeenCalledWith({ task: "minute", scheduledAt: "2026-08-04T01:00:00.000Z" });
    expect(runMinute).toHaveBeenCalledTimes(2);
  });

  it("reports a grace-timeout while a locked task is still running", async () => {
    // 关闭期限到达时不得谎称空闲：调用方可以继续关闭 HTTP 与数据库，避免一条卡住的外部任务永久阻塞 NAS 发布。
    const clock = fakeClock();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = startScheduler({
      database: databaseWithLock(async (_key, work) => work()),
      runMinute: async () => blocked,
      runSixHour: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined),
      recordSafeFailure: vi.fn(),
    }, clock);

    clock.triggerMinute(new Date("2026-08-04T01:00:00.000Z"));
    await Promise.resolve();
    await expect(scheduler.waitForIdle(1)).resolves.toBe(false);
    release();
    await expect(scheduler.waitForIdle(100)).resolves.toBe(true);
  });
});
