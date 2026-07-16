/** 手动刷新请求的最小行模型；不记录浏览器、IP 或会话标识，避免为冷却功能增加不必要的个人数据。 */
interface ManualRefreshRequestRow {
  requestedAt: string;
}

/** 手动刷新冷却由产品固定为十五分钟；服务器以毫秒计算，再将结果返回给前端展示倒计时。 */
export const manualRefreshCooldownMs = 15 * 60 * 1000;

/** 已接受或仍处于冷却中的结果都包含下一次允许时间，客户端无需自行猜测服务器时钟。 */
export interface ManualRefreshRequestResult {
  accepted: boolean;
  requestedAt: string;
  nextAllowedAt: string;
}

/**
 * 手动刷新队列的 D1 边界。表只保留一条最新请求，后续定时执行器消费 queued 状态，
 * 从而避免每个浏览器点击都直接并发访问任天堂和第三方价格站。
 */
export class ManualRefreshRepository {
  public constructor(private readonly database: D1Database) {}

  /**
   * 通过带条件的 UPSERT 原子地申请冷却名额。不能先 SELECT 再 UPDATE，
   * 否则两个并发标签页都可能读到旧时间并绕过限流，造成外部来源请求突增。
   */
  public async request(now: string): Promise<ManualRefreshRequestResult> {
    const nowMillis = Date.parse(now);
    const cutoff = new Date(nowMillis - manualRefreshCooldownMs).toISOString();
    const result = await this.database
      .prepare(
        `INSERT INTO manual_refresh_requests (id, requested_at, status)
         VALUES (1, ?, 'queued')
         ON CONFLICT(id) DO UPDATE SET requested_at = excluded.requested_at, status = 'queued'
         WHERE manual_refresh_requests.requested_at <= ?`,
      )
      .bind(now, cutoff)
      .run();

    if (result.meta.changes === 1) {
      return { accepted: true, requestedAt: now, nextAllowedAt: new Date(nowMillis + manualRefreshCooldownMs).toISOString() };
    }

    // 未写入说明已有请求仍在冷却；读取数据库的真实时间，避免客户端时钟与 Worker 时钟不同导致倒计时错误。
    const existing = await this.database
      .prepare("SELECT requested_at AS requestedAt FROM manual_refresh_requests WHERE id = 1")
      .first<ManualRefreshRequestRow>();
    if (!existing) throw new Error("手动刷新队列状态异常。");
    return {
      accepted: false,
      requestedAt: existing.requestedAt,
      nextAllowedAt: new Date(Date.parse(existing.requestedAt) + manualRefreshCooldownMs).toISOString(),
    };
  }
}
