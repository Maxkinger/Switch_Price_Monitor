import type { SqlExecutor } from "../../server/database/types";

/**
 * PostgreSQL 数据保留仓储只接受服务计算完成的 ISO 截止时刻。
 * 所有删除均参数化且返回驱动确认的受影响行数，仓储不会自行推断管理员策略或接受任意表名。
 */
export class RetentionRepository {
  public constructor(private readonly database: SqlExecutor) {}

  /** 严格删除早于价格截止点的快照；等于截止点的记录属于保留窗口，必须继续可审计。 */
  public async deletePriceSnapshotsBefore(cutoff: string): Promise<number> {
    const result = await this.database.query(
      "DELETE FROM price_snapshots WHERE captured_at < $1",
      [cutoff],
    );
    return result.rowCount;
  }

  /** 日志固定九十天策略与价格设置隔离；相等边界同样保留，避免按毫秒重复运行时误多删一批诊断事实。 */
  public async deleteFetchLogsBefore(cutoff: string): Promise<number> {
    const result = await this.database.query(
      "DELETE FROM fetch_logs WHERE captured_at < $1",
      [cutoff],
    );
    return result.rowCount;
  }
}
