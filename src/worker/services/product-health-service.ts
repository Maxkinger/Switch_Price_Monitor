import { ProductHealthRepository } from "../repositories/product-health-repository";
import { evaluateHealthTransition, type HealthTransition } from "./price-rules";

/**
 * 将纯健康规则与 D1 状态连接起来的应用服务。采集执行器每次得到成功或失败结果后调用它，
 * 返回的 notification 只是待发送意图，真正发送仍必须经过 notification_events 的唯一键去重。
 */
export class ProductHealthService {
  // 服务接收 Worker 的 D1 绑定并在内部固定仓储边界，使采集执行器不能绕过规则层直接拼写健康状态 SQL。
  private readonly health: ProductHealthRepository;

  public constructor(database: D1Database) {
    this.health = new ProductHealthRepository(database);
  }

  /**
   * 记录一轮地区商品采集结果并返回状态变迁。成功才写入 last_success_at，
   * 这样页面可准确显示最后成功时间而不会把一次失败误标为已刷新；now 必须使用 Worker 时钟而非浏览器时间。
   */
  public async record(regionalProductId: string, didSucceed: boolean, now: string): Promise<HealthTransition> {
    const transition = evaluateHealthTransition(await this.health.get(regionalProductId), didSucceed);
    await this.health.save(regionalProductId, transition, didSucceed ? now : null, now);
    return transition;
  }
}
