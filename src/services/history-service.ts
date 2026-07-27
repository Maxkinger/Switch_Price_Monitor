import type { HistoryReader, HistorySnapshot } from "../repositories/ports";

/** 继续导出现有历史 DTO 名称，路由和前端不需要了解数据库迁移。 */
export type HistoryRow = HistorySnapshot;

/** 历史服务只转发业务参数给窄 reader，不接触 SQL、pg 行或 D1 API。 */
export class HistoryService {
  public constructor(private readonly history: HistoryReader) {}

  public list(subscriptionId: string, region: string | null): Promise<{ snapshots: HistorySnapshot[] }> {
    return this.history.list(subscriptionId, region);
  }
}
