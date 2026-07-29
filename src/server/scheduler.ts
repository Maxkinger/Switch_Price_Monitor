import type { AppDatabase } from "./database/types";

/**
 * 时钟回调携带本轮唯一计划时刻；实现不得让业务任务自行读取系统本地时区，
 * 从而保证日报判断、通知审计与 PostgreSQL 锁竞争都围绕同一 UTC 边界。
 */
export interface SchedulerClock {
  everyMinute(callback: (scheduledAt: Date) => void): { stop(): void };
  everySixHours(callback: (scheduledAt: Date) => void): { stop(): void };
}

/** 调度器只接收已装配的领域任务和安全失败出口，不能访问环境变量、Telegram 凭据或原始错误正文。 */
export interface SchedulerDependencies {
  database: AppDatabase;
  runMinute(scheduledAt: string): Promise<void>;
  runSixHour(scheduledAt: string): Promise<void>;
  recordSafeFailure(input: {
    task: "minute" | "six-hour";
    scheduledAt: string;
  }): void;
}

/** 关停边界先阻止新触发，再在调用方给定的剩余宽限内观察已接收任务，不强制取消数据库事务。 */
export interface SchedulerHandle {
  stop(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

/**
 * 分钟任务使用固定 signed bigint 锁键。该值与迁移锁及后续六小时锁分离，
 * 使多个应用实例只会跳过同类重复工作，不会把互不相关的维护任务错误串行化。
 */
const minuteAdvisoryLockKey = 8_602_727_101n;

/**
 * 六小时任务使用另一固定 signed bigint 锁键；它与分钟锁不同，允许正常日报判断与较慢采集并行，
 * 但相同六小时任务在重复容器或上一轮未结束时只能由一个实例执行。
 */
const sixHourAdvisoryLockKey = 8_602_727_102n;
const minuteMilliseconds = 60_000;
const sixHourMilliseconds = 6 * 60 * minuteMilliseconds;

/**
 * 启动当前最小调度生命周期。回调先把 Date 转为一次 ISO 快照，再进入 PostgreSQL 非阻塞锁；
 * 锁未取得时 withAdvisoryLock 返回 undefined，本轮自然结束且不会排队补跑。
 */
export function startScheduler(
  dependencies: SchedulerDependencies,
  clock: SchedulerClock = createUtcSchedulerClock(),
): SchedulerHandle {
  const activeTasks = new Set<Promise<void>>();
  let stopped = false;

  const minuteTimer = clock.everyMinute((scheduledAt) => {
    if (stopped) return;
    const capturedScheduledAt = scheduledAt.toISOString();
    trackTask(runLockedTask(
      "minute",
      capturedScheduledAt,
      minuteAdvisoryLockKey,
      dependencies.runMinute,
    ));
  });
  const sixHourTimer = clock.everySixHours((scheduledAt) => {
    if (stopped) return;
    const capturedScheduledAt = scheduledAt.toISOString();
    trackTask(runLockedTask(
      "six-hour",
      capturedScheduledAt,
      sixHourAdvisoryLockKey,
      dependencies.runSixHour,
    ));
  });

  function trackTask(task: Promise<void>): void {
    activeTasks.add(task);
    // 成功与失败都显式附加处理器；不能使用无人接收的 finally 派生 promise，否则清理回调异常会形成 unhandled rejection。
    void task.then(
      () => activeTasks.delete(task),
      () => activeTasks.delete(task),
    );
  }

  async function runLockedTask(
    task: "minute" | "six-hour",
    scheduledAt: string,
    lockKey: bigint,
    run: (scheduledAt: string) => Promise<void>,
  ): Promise<void> {
    try {
      await dependencies.database.withAdvisoryLock(
        lockKey,
        async () => run(scheduledAt),
      );
    } catch {
      // 原始数据库、Telegram 或价格来源错误都可能包含敏感上下文；安全出口只接收任务种类和既捕获的 UTC 时刻。
      try {
        dependencies.recordSafeFailure({ task, scheduledAt });
      } catch {
        // 安全记录器本身不可用时也不能传播其异常；调度器没有第二日志出口，避免递归记录或泄漏原始上下文。
      }
    }
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      minuteTimer.stop();
      sixHourTimer.stop();
    },

    async waitForIdle(timeoutMs: number): Promise<boolean> {
      if (activeTasks.size === 0) return true;
      const idle = Promise.allSettled([...activeTasks]).then(() => true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timeout.unref();
      });
      const result = await Promise.race([idle, expired]);
      if (timeout) clearTimeout(timeout);
      return result;
    },
  };
}

/**
 * 默认 Node 时钟只使用 epoch 毫秒，因此天然以 UTC 边界对齐，不读取宿主本地时区。
 * 两类 timer 都按目标边界递归重算；进程暂停导致错过边界时直接跳到下一轮，禁止排队补跑。
 */
function createUtcSchedulerClock(): SchedulerClock {
  return {
    everyMinute: (callback) => createAlignedTimer(minuteMilliseconds, callback),
    everySixHours: (callback) => createAlignedTimer(sixHourMilliseconds, callback),
  };
}

/**
 * 安排严格晚于当前时刻的下一整除边界。回调收到预先捕获的目标 Date，而不是唤醒后的 Date.now()；
 * 即使事件循环略有延迟，日报、通知与数据库审计仍使用同一个计划 UTC 时刻。
 */
function createAlignedTimer(
  periodMilliseconds: number,
  callback: (scheduledAt: Date) => void,
): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;
    const now = Date.now();
    const targetEpoch = (Math.floor(now / periodMilliseconds) + 1) * periodMilliseconds;
    timer = setTimeout(() => {
      if (stopped) return;
      callback(new Date(targetEpoch));
      // 重新读取当前 epoch 而非简单累加 delay，可消除事件循环停顿带来的 setInterval 漂移与积压。
      scheduleNext();
    }, Math.max(0, targetEpoch - now));
    // 孤立调度 timer 不是阻止 Node 容器退出的资源；HTTP 与数据库生命周期由进程协调器显式拥有。
    timer.unref();
  };

  scheduleNext();
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
