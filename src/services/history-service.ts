import type { HistoryReader } from "../repositories/ports";

/** 价格历史行只含展示和导出所需字段；不返回内部快照 ID、数据库时间对象或任何认证资料。 */
export interface HistoryRow {
  regionCode: string;
  amountMinor: number;
  currency: string;
  cnyFen: number | null;
  source: string;
  capturedAt: string;
}

/** 历史响应保持既有对象外壳，便于前端未来增加分页元数据而不把数据库结果数组直接暴露为 API 根值。 */
export interface HistoryResult {
  snapshots: HistoryRow[];
}

/**
 * 历史服务只委托窄读取端口；订阅 ID、地区筛选和 SQL 参数化由仓储负责，
 * 服务与路由不会接触 PostgreSQL client、D1 statement 或底层时间对象。
 */
export class HistoryService {
  public constructor(private readonly reader: HistoryReader) {}

  public async list(subscriptionId: string, region: string | null): Promise<HistoryResult> {
    return this.reader.list(subscriptionId, region);
  }
}

/** 将已经完成字段白名单和时间规范化的快照包装为稳定服务 DTO，不接受任意数据库元数据。 */
export function buildHistoryResult(snapshots: HistoryRow[]): HistoryResult {
  return { snapshots };
}
