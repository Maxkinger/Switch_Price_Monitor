import type { SqlExecutor } from "../../server/database/types";
import type { ManualRefreshRequestResult, ManualRefreshStore } from "../ports";

/** PostgreSQL TIMESTAMPTZ 返回 Date；仓储统一转换，路由不会接触驱动类型或 NAS 本地时区。 */
interface ManualRefreshRow {
  requestedAt: Date | string;
}

/**
 * PostgreSQL 手动刷新仓储只保留单行最近请求时刻。
 * 它不保存管理员、会话、商品、价格响应、通知正文或 queued/running 状态，避免为临时操作积累不必要的行为与秘密数据。
 */
export class ManualRefreshRepository implements ManualRefreshStore {
  public constructor(private readonly database: SqlExecutor) {}

  /**
   * 当前产品规则允许连续刷新，故每次都 accepted；GREATEST 防止较早请求因较晚提交而让“最近刷新时间”倒退。
   * 采集器仍在数据库语句提交后由服务同步运行，不能把外部任天堂请求包进事务长期占用连接。
   */
  public async request(now: string): Promise<ManualRefreshRequestResult> {
    const result = await this.database.query<ManualRefreshRow>(
      `INSERT INTO manual_refresh_requests (id, requested_at)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE
       SET requested_at = GREATEST(manual_refresh_requests.requested_at, EXCLUDED.requested_at)
       RETURNING requested_at AS "requestedAt"`,
      [now],
    );
    const requestedAt = toIsoString(result.rows[0]?.requestedAt);
    return { accepted: true, requestedAt, nextAllowedAt: requestedAt };
  }
}

/** 缺失或无效数据库时间表示迁移/驱动异常，不能伪造为当前时间掩盖状态回退。 */
function toIsoString(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : value === undefined ? new Date(Number.NaN) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("手动刷新时间无效。");
  return date.toISOString();
}
