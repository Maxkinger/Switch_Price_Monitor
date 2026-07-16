import type { SubscriptionInput } from "../../shared/domain";
import { SubscriptionRepository } from "../repositories/subscription-repository";

/** 创建或打开订阅后的最小结果；前端只需要知道应跳转的订阅和是否首次创建，不应获得数据库内部信息。 */
export interface CreateOrOpenSubscriptionResult {
  subscriptionId: string;
  created: boolean;
}

/** 地区商品不存在、属于其他游戏或已停用时统一抛出，避免把数据库细节暴露为 API 响应。 */
export class RegionalProductMismatchError extends Error {}

/** 停用或重新启用不存在的订阅使用显式领域错误，路由可返回 404 而非把它伪装为成功。 */
export class SubscriptionNotFoundError extends Error {}

/**
 * 订阅服务承载“同一逻辑游戏只有一个订阅”的业务规则。
 * 它不在这里搜索或猜测商品；传入的地区商品 ID 必须已由后续的商品确认流程验证，避免把本体、DLC 与升级包混订。
 */
export class SubscriptionService {
  public constructor(private readonly subscriptions: SubscriptionRepository) {}

  /**
   * 重复提交同一 gameId 时返回既有订阅而不覆盖地区范围，保护管理员已经确认的监控配置。
   * 新建记录的时间由 Worker 生成，不能信任浏览器提供的 createdAt，以保证审计时间和服务端时钟一致。
   */
  public async createOrOpen(
    input: Omit<SubscriptionInput, "createdAt">,
    now: string,
  ): Promise<CreateOrOpenSubscriptionResult> {
    const existing = await this.subscriptions.findByGameId(input.gameId);
    if (existing) return { subscriptionId: existing.id, created: false };

    // 写入关系表前必须确认每一个 ID 的游戏归属和启用状态，避免跨游戏价格混入同一订阅的历史与日报。
    if (!(await this.subscriptions.hasEnabledProductsForGame(input.gameId, input.regionalProductIds))) {
      throw new RegionalProductMismatchError("地区商品不属于所选游戏。");
    }

    await this.subscriptions.create({ ...input, createdAt: now });
    return { subscriptionId: input.id, created: true };
  }

  /**
   * 切换订阅软状态。停用不是删除操作：历史快照、地区映射和目标价状态都要继续存在，
   * 采集器仅根据 enabled 决定是否继续生成新记录和通知。
   */
  public async setEnabled(subscriptionId: string, enabled: boolean, now: string): Promise<void> {
    if (!(await this.subscriptions.setEnabled(subscriptionId, enabled, now))) {
      throw new SubscriptionNotFoundError("订阅不存在。");
    }
  }
}
