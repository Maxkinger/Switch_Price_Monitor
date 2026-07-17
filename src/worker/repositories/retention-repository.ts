/**
 * 数据保留的 D1 写入边界。清理由受控调度器传入 ISO 截止时间，
 * 仓储只执行参数化删除，既不接受任意 SQL，也不自行推断管理员选择的保留策略。
 */
export class RetentionRepository {
  public constructor(private readonly database: D1Database) {}

  /**
   * 删除严格早于价格历史截止点的快照，并保留恰好位于截止时刻的记录。
   * 使用严格小于号使“保留一年/两年”的日历边界可审计，且参数绑定避免时间字符串进入 SQL 结构。
   */
  public async deletePriceSnapshotsBefore(cutoff: string): Promise<number> {
    const result = await this.database.prepare("DELETE FROM price_snapshots WHERE captured_at < ?").bind(cutoff).run();
    return result.meta.changes;
  }

  /**
   * 删除严格早于固定九十天截止点的诊断日志；日志策略独立于价格历史设置，
   * 防止管理员永久保留价格时也无意无限累积可能包含故障摘要的运维数据。
   */
  public async deleteFetchLogsBefore(cutoff: string): Promise<number> {
    const result = await this.database.prepare("DELETE FROM fetch_logs WHERE captured_at < ?").bind(cutoff).run();
    return result.meta.changes;
  }
}
