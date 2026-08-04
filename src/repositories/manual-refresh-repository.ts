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
   * 临时验证期间每个请求都可进入采集，但最近刷新审计时间仍必须取最大 UTC 时刻，避免较早请求在较晚请求提交后令记录倒退。
   * 单行 UPSERT 不追加管理员行为记录；若未来恢复限流，必须另行确认并恢复带阈值的条件写，而不能改变本次“无冷却、同步采集”规则。
   */
  public async request(now: string): Promise<ManualRefreshRequestResult> {
    const row = await this.database
      .prepare(
        `INSERT INTO manual_refresh_requests (id, requested_at)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET requested_at = CASE
           WHEN excluded.requested_at > manual_refresh_requests.requested_at THEN excluded.requested_at
           ELSE manual_refresh_requests.requested_at
         END
         RETURNING requested_at AS requestedAt`,
      )
      .bind(now)
      .first<{ requestedAt: string }>();
    if (!row) throw new Error("最近刷新时间未能保存。");
    return { accepted: true, requestedAt: row.requestedAt, nextAllowedAt: row.requestedAt };
  }

}
