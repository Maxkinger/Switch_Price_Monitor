import { NotificationEventRepository } from "../repositories/notification-event-repository";
import { ProductHealthRepository } from "../repositories/product-health-repository";
import { evaluateHealthTransition, type HealthTransition } from "./price-rules";

/**
 * 将纯健康规则与 D1 状态连接起来的应用服务。采集执行器每次得到成功或失败结果后调用它，
 * 仅在规则产生失败或恢复变迁时原子预留待发送事件；真正 Telegram 投递仍由后续调度器处理。
 */
export class ProductHealthService {
  // 服务接收 Worker 的 D1 绑定并在内部固定仓储边界，使采集执行器不能绕过规则层直接拼写健康状态 SQL。
  private readonly health: ProductHealthRepository;
  // 通知仓储将状态变化转换为一次性待发送事件，避免采集器直接访问 Telegram 凭据或网络。
  private readonly notifications: NotificationEventRepository;

  public constructor(database: D1Database) {
    this.health = new ProductHealthRepository(database);
    this.notifications = new NotificationEventRepository(database);
  }

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
