import type { ManualRefreshRequestResult, ManualRefreshStore } from "./ports";

// 保留旧入口的类型导出，过渡 Worker 与既有测试无需依赖具体数据库目录；新平台装配应直接引用 ports。
export type { ManualRefreshRequestResult } from "./ports";

/**
 * 临时无冷却手动刷新的 D1 边界。表只保留一条最近执行时间，服务每次请求后立即采集，
 * 因而不能保存 queued/running 任务状态，以免管理员误以为点击仍需等待 Cron 或积累队列。
 */
export class ManualRefreshRepository implements ManualRefreshStore {
  public constructor(private readonly database: D1Database) {}

  /**
   * 临时验证期间无条件原子写入最近刷新时间。并发请求都可以进入采集是产品明确授权的后果；
   * 仍使用单行 UPSERT 而非追加记录，避免为刷新频率收集不必要的浏览行为数据。恢复 15 分钟限流时必须另行确认并恢复条件 UPSERT。
   */
  public async request(now: string): Promise<ManualRefreshRequestResult> {
    await this.database
      .prepare(
        `INSERT INTO manual_refresh_requests (id, requested_at)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET requested_at = excluded.requested_at`,
      )
      .bind(now)
      .run();
    return { accepted: true, requestedAt: now, nextAllowedAt: now };
  }

}
