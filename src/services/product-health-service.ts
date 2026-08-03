import type { NotificationEventStore, ProductHealthStore } from "../repositories/ports";
import { evaluateHealthTransition, type HealthTransition } from "./price-rules";

/**
 * 将纯健康规则与持久化端口连接起来的应用服务。采集执行器每次得到成功或失败结果后调用它，
 * 仅在规则产生失败或恢复变迁时原子预留待发送事件；真正 Telegram 投递仍由后续调度器处理。
 */
export class ProductHealthService {
  public constructor(
    // 健康端口只允许读取和保存规则计算后的最小状态，服务既看不到 SQL，也不能绕过业务状态机写任意列。
    private readonly health: ProductHealthStore,
    // 通知端口只原子预留事件；Telegram 凭据和网络投递继续由独立调度边界负责。
    private readonly notifications: Pick<NotificationEventStore, "reserve">,
  ) {}

  /**
   * 记录一轮地区商品采集结果并返回状态变迁。成功才写入 last_success_at，
   * 这样页面可准确显示最后成功时间而不会把一次失败误标为已刷新；now 必须使用服务端统一时钟而非浏览器时间。
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
