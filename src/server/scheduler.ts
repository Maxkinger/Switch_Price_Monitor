import type { AppDatabase } from "./database/types";

/** 两个固定锁键对应不同任务，允许分钟通知与六小时采集并行，但同类任务在多个 Node 进程间最多运行一次。 */
const MINUTE_SCHEDULER_LOCK_KEY = 5_793_041_001n;
const SIX_HOUR_SCHEDULER_LOCK_KEY = 5_793_041_002n;

/** 可替换时钟将真实计时器与调度语义分离；测试无需等待真实时间，生产仍使用 UTC Date。 */
export interface SchedulerClock {
  everyMinute(callback: (scheduledAt: Date) => void): { stop(): void };
  everySixHours(callback: (scheduledAt: Date) => void): { stop(): void };
}

/** 调度器只知道锁、两项已装配业务工作和脱敏失败记录，不持有 Telegram、价格来源或原始数据库连接。 */
export interface SchedulerDependencies {
  database: AppDatabase;
  runMinute(scheduledAt: string): Promise<void>;
  runSixHour(scheduledAt: string): Promise<void>;
  recordSafeFailure(input: { task: "minute" | "six-hour"; scheduledAt: string }): void;
}

/** 停止定时触发并等待当前锁内任务完成的句柄；超时仅报告 false，关闭流程可据此继续释放进程资源。 */
export interface SchedulerHandle {
  stop(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

/**
 * 启动 PostgreSQL advisory lock 保护的 Node 调度器。每次触发仅捕获一次 UTC 时刻，
 * 锁竞争者立即跳过而非排队，避免日报、即时通知或六小时采集在多进程/重启情况下重复执行。
 */
export function startScheduler(dependencies: SchedulerDependencies, clock: SchedulerClock = systemClock): SchedulerHandle {
  let accepting = true;
  const active = new Set<Promise<void>>();
  const minute = clock.everyMinute((scheduledAt) => run("minute", MINUTE_SCHEDULER_LOCK_KEY, dependencies.runMinute, scheduledAt));
  const sixHour = clock.everySixHours((scheduledAt) => run("six-hour", SIX_HOUR_SCHEDULER_LOCK_KEY, dependencies.runSixHour, scheduledAt));

  function run(task: "minute" | "six-hour", lockKey: bigint, work: (scheduledAt: string) => Promise<void>, date: Date): void {
    if (!accepting) return;
    const scheduledAt = date.toISOString();
    const promise = dependencies.database
      .withAdvisoryLock(lockKey, async () => work(scheduledAt))
      .catch(() => {
        // 只记录任务类别与 UTC 时刻；错误对象可能含连接串、外部 URL 或 Telegram 响应，不能写入常规日志。
        dependencies.recordSafeFailure({ task, scheduledAt });
      })
      .finally(() => active.delete(promise));
    active.add(promise);
  }

  return {
    stop() {
      if (!accepting) return;
      accepting = false;
      // 先停止两个触发源，再让已进入 advisory lock 的任务自行结束，禁止关闭期间排队产生新业务写入。
      minute.stop();
      sixHour.stop();
    },
    async waitForIdle(timeoutMs) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (active.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let clearTimer!: () => void;
        const timedOut = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), remaining);
          clearTimer = () => clearTimeout(timer);
        });
        const settled = await Promise.race([Promise.allSettled([...active]).then(() => true), timedOut]);
        // 任务先完成时必须取消剩余的等待计时器；否则无工作进程也会被 grace timeout 的句柄意外保活。
        clearTimer();
        if (!settled) return false;
      }
      return true;
    },
  };
}

/** 系统时钟对齐到下一分钟/六小时时界，避免从进程启动时刻开始漂移；每次回调构造新的 UTC Date。 */
const systemClock: SchedulerClock = {
  everyMinute(callback) {
    return alignedInterval(60_000, callback);
  },
  everySixHours(callback) {
    return alignedInterval(6 * 60 * 60 * 1000, callback);
  },
};

function alignedInterval(periodMs: number, callback: (scheduledAt: Date) => void): { stop(): void } {
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const delay = periodMs - (Date.now() % periodMs);
  const timeout = setTimeout(() => {
    if (stopped) return;
    callback(new Date());
    interval = setInterval(() => callback(new Date()), periodMs);
  }, delay);
  return {
    stop() {
      stopped = true;
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    },
  };
}
