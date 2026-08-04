import type { SubscriptionInput } from "../shared/domain";
import type { SubscriptionStore } from "../repositories/ports";

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
  public constructor(private readonly subscriptions: SubscriptionStore) {}

  /**
   * 重复提交同一 gameId 时返回既有订阅而不覆盖地区范围，保护管理员已经确认的监控配置。
   * 新建记录的时间由服务端生成，不能信任浏览器提供的 createdAt，以保证审计时间和服务端时钟一致。
   */
  public async createOrOpen(
    input: Omit<SubscriptionInput, "createdAt">,
    now: string,
  ): Promise<CreateOrOpenSubscriptionResult> {
    // 查重、商品归属、主记录与关系写入必须共享仓储事务；并发双击只会返回获胜订阅，不能留下空订阅或覆盖既有地区。
    const result = await this.subscriptions.createOrOpenAtomically({ ...input, createdAt: now });
    if (result.status === "product-mismatch") throw new RegionalProductMismatchError("地区商品不属于所选游戏。");
    return { subscriptionId: result.subscriptionId, created: result.status === "created" };
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

  /** 保存全局人民币和单区当地货币目标；单区记录由规则层优先使用。 */
  public async setTargets(subscriptionId: string, globalTargetCnyFen: number | null, regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>, now: string): Promise<void> {
    if (!(await this.subscriptions.setTargets(subscriptionId, globalTargetCnyFen, regionTargets, now))) throw new SubscriptionNotFoundError("订阅不存在。");
  }

  /** 更新监控地区前确认订阅存在且全部地区商品属于同一逻辑游戏，避免跨游戏历史混合。 */
  public async replaceRegionalProducts(subscriptionId: string, regionalProductIds: string[], now: string): Promise<void> {
    const result = await this.subscriptions.replaceRegionalProductsAtomically(subscriptionId, regionalProductIds, now);
    if (result === "not-found") throw new SubscriptionNotFoundError("订阅不存在。");
    if (result === "product-mismatch") throw new RegionalProductMismatchError("地区商品不属于所选游戏。");
  }

  /**
   * 硬删除返回调用方已通过路由去重后的原始 ID 顺序，供前端准确移除所选卡片。
   * 仓储会在同一事务中先锁定并验证所有订阅存在；发现任一不存在即抛 404 且不执行 DELETE，防止多选操作部分成功而让用户误以为全部已删除。
   */
  public async deleteMany(subscriptionIds: string[]): Promise<string[]> {
    if (!(await this.subscriptions.deleteMany(subscriptionIds))) {
      throw new SubscriptionNotFoundError("订阅不存在。");
    }
    return subscriptionIds;
  }
}
