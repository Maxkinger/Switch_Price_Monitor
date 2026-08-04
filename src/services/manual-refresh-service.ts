import type { ManualRefreshStore } from "../repositories/ports";

/**
 * 立即采集端口与 LiveCollectionRunner 的聚合结果对齐，避免刷新服务了解商品、汇率、价格来源或通知细节。
 * 路由仅能依据这些计数反馈本次执行状态，不能把外部商店页面或内部地区商品 ID 返回给浏览器。
 */
export interface ImmediateRefreshRunner {
  run(now: string): Promise<{ attempted: number; collected: number; stale: number }>;
}

/** 手动刷新完成结果以服务端时间为准，既可供界面重新拉取仪表盘，也不泄露采集过程中的敏感原始数据。 */
export interface ManualRefreshResult {
  executedAt: string;
  attempted: number;
  collected: number;
  stale: number;
}

/**
 * 手动刷新服务先以仓储单语句记录最近请求时刻，再在同一 HTTP 请求内运行统一采集器。
 * 它不直接解析任天堂或第三方页面，因此手动与 Cron 路径仍复用完全相同的来源、汇率、健康检查和通知规则。
 */
export class ManualRefreshService {
  public constructor(
    private readonly requests: ManualRefreshStore,
    private readonly runner: ImmediateRefreshRunner,
  ) {}

  /**
   * 每个请求都由服务端 UTC 时间盖章并立即进入一次统一采集；当前产品规则没有 15 分钟冷却，浏览器也不能回填审计时间。
   * 最近时刻先于采集写入，即使官方商店失败仍保留可追溯操作事实；若仓储违反“当前总接受”契约，作为内部故障交给路由脱敏，而不能伪装为过期的 429 限流。
   */
  public async refresh(now: string): Promise<ManualRefreshResult> {
    const request = await this.requests.request(now);
    if (!request.accepted) throw new Error("手动刷新请求未被接受。");
    const result = await this.runner.run(now);
    return { executedAt: now, ...result };
  }
}
