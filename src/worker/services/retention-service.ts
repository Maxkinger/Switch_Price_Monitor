import type { AppSettings } from "../../shared/domain";

/** 采集日志的固定保留天数不随价格历史策略变化，保证近期异常可排查且数据库不会无限增长。 */
const fetchLogRetentionDays = 90;

/**
 * 保留服务依赖的最小持久化能力。通过窄接口隔离 D1 实现，
 * 让策略层只能请求受控的截止时间删除，不能读取或暴露不必要的历史价格内容。
 */
export interface RetentionStore {
  deletePriceSnapshotsBefore(cutoff: string): Promise<number>;
  deleteFetchLogsBefore(cutoff: string): Promise<number>;
}

/** 清理结果仅包含删除数量，供后续安全日志记录和运行监控使用，不返回可能敏感的原始诊断文本。 */
export interface RetentionCleanupResult {
  priceSnapshotsDeleted: number;
  fetchLogsDeleted: number;
}

/**
 * 返回价格快照应被删除的最早边界；永久保留返回 null。
 * 闰日向非闰年回退到该月最后一天，避免 Date 的自动进位把“保留一年”错误延长到三月。
 */
export function priceRetentionCutoff(now: string, policy: AppSettings["priceHistoryRetention"]): string | null {
  if (policy === "forever") return null;
  const date = new Date(now);
  const years = policy === "one-year" ? 1 : 2;
  const targetYear = date.getUTCFullYear() - years;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(targetYear, month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds())).toISOString();
}

/** 用 UTC 的精确 90 天窗口清理诊断日志，使所有 Cron 节点对同一 ISO 时间戳得到一致结果。 */
export function fetchLogRetentionCutoff(now: string): string {
  return new Date(Date.parse(now) - fetchLogRetentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 将设置中的保留策略转换为受控的数据库清理操作。价格历史可被管理员永久保留，
 * 但采集日志始终遵循九十天上限，防止故障摘要长期无限堆积。
 */
export class RetentionService {
  public constructor(private readonly store: RetentionStore) {}

  /**
   * 在单个调度周期内执行两类清理并返回可审计计数。永久价格策略只跳过快照删除，
   * 绝不跳过日志删除；所有截止时间由纯函数生成，确保不同 Worker 节点使用相同 UTC 边界。
   */
  public async cleanup(now: string, policy: AppSettings["priceHistoryRetention"]): Promise<RetentionCleanupResult> {
    const priceCutoff = priceRetentionCutoff(now, policy);
    const priceSnapshotsDeleted = priceCutoff ? await this.store.deletePriceSnapshotsBefore(priceCutoff) : 0;
    const fetchLogsDeleted = await this.store.deleteFetchLogsBefore(fetchLogRetentionCutoff(now));
    return { priceSnapshotsDeleted, fetchLogsDeleted };
  }
}
