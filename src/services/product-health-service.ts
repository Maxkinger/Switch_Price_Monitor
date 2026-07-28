import type { NotificationEventStore, ProductHealthStore } from "../repositories/ports";
import { evaluateHealthTransition, type HealthTransition } from "./price-rules";

/**
 * 将纯健康规则与平台中立仓储状态连接起来的应用服务。采集执行器每次得到成功或失败结果后调用它，
 * 仅在规则产生失败或恢复变迁时原子预留待发送事件；真正 Telegram 投递仍由后续调度器处理。
 */
export class ProductHealthService {
  public constructor(
    // 健康状态和通知预留都以窄端口注入，使 Node/PostgreSQL 与 Worker 兼容入口复用同一规则服务。
    private readonly health: ProductHealthStore,
    // 通知仓储只取得去重事件 DTO，服务和采集器均不会接触 Telegram 凭据或数据库驱动。
    private readonly notifications: NotificationEventStore,
  ) {}

  /**
   * 记录一轮地区商品采集结果并返回状态变迁。成功才写入 last_success_at，
   * 这样页面可准确显示最后成功时间而不会把一次失败误标为已刷新；now 必须使用 Worker 时钟而非浏览器时间。
   */
  public async record(regionalProductId: string, didSucceed: boolean, now: string): Promise<HealthTransition> {
    const transition = evaluateHealthTransition(await this.health.get(regionalProductId), didSucceed);
    await this.health.save(regionalProductId, transition, didSucceed ? now : null, now);
    if (transition.notification !== "none") {
      const eventType = transition.notification === "failure" ? "collection-failure" : "collection-recovered";
      // 状态变迁时刻进入唯一键：同一 Cron 重试使用相同输入会被数据库忽略，不会产生第二次推送资格。
      await this.notifications.reserve({ regionalProductId, eventType, dedupeKey: `${regionalProductId}:${eventType}:${now}`, createdAt: now });
    }
    return transition;
  }
}
