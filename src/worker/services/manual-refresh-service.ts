import { ManualRefreshRepository, type ManualRefreshRequestResult } from "../repositories/manual-refresh-repository";

/** 冷却中的显式领域错误由 HTTP 路由转换为 429，避免把正常的限流状态伪装成服务器故障。 */
export class ManualRefreshCooldownError extends Error {
  public constructor(public readonly nextAllowedAt: string) {
    super("请在冷却结束后再次刷新。");
  }
}

/**
 * 手动刷新服务只负责排队与冷却，不在 HTTP 请求中直接爬取价格。
 * 定时执行器随后消费 queued 请求并复用同一采集链，避免手动与 Cron 两条路径产生不同的来源、汇率或告警结果。
 */
export class ManualRefreshService {
  public constructor(private readonly requests: ManualRefreshRepository) {}

  /** 接受的请求由服务端当前时间盖章；浏览器提供的时间不可用于冷却，以免被篡改绕过频率限制。 */
  public async queue(now: string): Promise<ManualRefreshRequestResult> {
    const result = await this.requests.request(now);
    if (!result.accepted) throw new ManualRefreshCooldownError(result.nextAllowedAt);
    return result;
  }
}
