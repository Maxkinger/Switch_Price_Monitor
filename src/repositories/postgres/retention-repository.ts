import type { SqlExecutor } from "../../server/database/types";
import type { RetentionStore } from "../ports";

/**
 * PostgreSQL 数据保留仓储。
 * 截止点由服务层按管理员策略生成并通过参数传入；严格小于保留等于边界的价格与诊断证据，
 * `rowCount` 已由 Task 2 执行器规范为非空 number，不读取或返回日志正文。
 */
export class PostgresRetentionRepository implements RetentionStore {
  public constructor(private readonly database: SqlExecutor) {}

  public async deletePriceSnapshotsBefore(cutoff: string): Promise<number> {
    const result = await this.database.query(
      "DELETE FROM price_snapshots WHERE captured_at < $1",
      [cutoff],
    );
    return result.rowCount;
  }

  public async deleteFetchLogsBefore(cutoff: string): Promise<number> {
    const result = await this.database.query(
      "DELETE FROM fetch_logs WHERE captured_at < $1",
      [cutoff],
    );
    return result.rowCount;
  }
}
