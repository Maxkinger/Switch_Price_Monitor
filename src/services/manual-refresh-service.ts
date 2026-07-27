import { ManualRefreshRepository } from "../repositories/manual-refresh-repository";

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

/** 冷却中的显式领域错误由 HTTP 路由转换为 429，避免把正常的限流状态伪装成服务器故障。 */
export class ManualRefreshCooldownError extends Error {
  public constructor(public readonly nextAllowedAt: string) {
    super("请在冷却结束后再次刷新。");
  }
}

/**
 * 手动刷新服务先以 D1 原子记录取得十五分钟冷却名额，再在同一 HTTP 请求内运行统一采集器。
 * 它不直接解析任天堂或第三方页面，因此手动与 Cron 路径仍复用完全相同的来源、汇率、健康检查和通知规则。
 */
export class ManualRefreshService {
  public constructor(
    private readonly requests: ManualRefreshRepository,
    private readonly runner: ImmediateRefreshRunner,
  ) {}

  /**
   * 接受的请求由服务端当前时间盖章；浏览器提供的时间不可用于冷却，以免被篡改绕过频率限制。
   * 冷却记录在采集前写入：即使官方商店暂时失败，也不能允许浏览器立刻重复请求而加剧来源限流；
   * 失败会由路由转换为安全错误，采集器仍负责写入可恢复的健康状态与日志。
   */
  public async refresh(now: string): Promise<ManualRefreshResult> {
    const request = await this.requests.request(now);
    if (!request.accepted) throw new ManualRefreshCooldownError(request.nextAllowedAt);
    const result = await this.runner.run(now);
    return { executedAt: now, ...result };
  }
}
