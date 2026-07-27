import type { SubscriptionDetail } from "../repositories/subscription-detail-repository";
import { SubscriptionNotFoundError } from "./subscription-service";

/**
 * 详情仓储的最小读取边界。接口使服务可在不依赖 D1 的情况下测试业务 404 语义，
 * 并明确路由只能得到已经脱敏、稳定的 SubscriptionDetail，而不是原始数据库记录。
 */
export interface SubscriptionDetailRepositoryPort {
  find(subscriptionId: string): Promise<SubscriptionDetail | null>;
}

/**
 * 订阅详情服务只负责将“缺失”翻译为既有订阅领域错误。路由复用同一 404 响应，
 * 因此不会把数据库故障、会话信息或 SQL 内容误作为客户端的订阅不存在提示。
 */
export class SubscriptionDetailService {
  public constructor(private readonly details: SubscriptionDetailRepositoryPort) {}

  public async get(subscriptionId: string): Promise<SubscriptionDetail> {
    const detail = await this.details.find(subscriptionId);
    if (!detail) throw new SubscriptionNotFoundError("订阅不存在。");
    return detail;
  }
}
