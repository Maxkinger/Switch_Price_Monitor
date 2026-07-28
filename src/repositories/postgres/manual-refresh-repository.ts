import type { ManualRefreshRequestResult } from "../manual-refresh-repository";
import type { ManualRefreshRequestStore } from "../ports";
import type { SqlExecutor } from "../../server/database/types";

/**
 * PostgreSQL 手动刷新仓储只保留单行最近请求时间，不收集管理员、会话、商品或来源响应。
 * 当前产品明确临时取消冷却，因此并发请求均接受；原生 TIMESTAMPTZ 只用于审计最近执行时刻。
 */
export class PostgresManualRefreshRepository implements ManualRefreshRequestStore {
  public constructor(private readonly database: SqlExecutor) {}

  public async request(now: string): Promise<ManualRefreshRequestResult> {
    await this.database.query(
      `INSERT INTO manual_refresh_requests (id, requested_at)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE
             SET requested_at = EXCLUDED.requested_at`,
      [now],
    );
    return { accepted: true, requestedAt: now, nextAllowedAt: now };
  }
}
