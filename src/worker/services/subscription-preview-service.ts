import type { PriceSource, SubscriptionRegionPreview } from "../../shared/domain";
import type { OfficialPriceIdCandidate, OfficialPriceIdResolution } from "./official-price-id-service";

/** 允许预览服务依赖真实 ID 确认服务或离线测试桩件，而不耦合网络、D1 或任天堂实现细节。 */
export interface OfficialPriceIdResolver {
  resolve(candidate: OfficialPriceIdCandidate): Promise<OfficialPriceIdResolution>;
}

/** 首版经产品确认的默认第三方回退次序；后续设置页可将同一构造参数替换为管理员保存的启用顺序。 */
export const defaultFallbackSources = ["eshop-prices", "nt-deals"] as const;

type ThirdPartySource = Exclude<PriceSource, "official">;

/**
 * 将每区官方 ID 确认结果转为创建订阅前的可读决策。服务不写数据库、不请求第三方：
 * 预览只告知管理员若官方不可用时会采用哪个已启用来源，真正采集仍由来源链遵循相同顺序执行。
 */
export class SubscriptionPreviewService {
  private readonly fallbackSources: ThirdPartySource[];

  public constructor(
    private readonly officialPriceIds: OfficialPriceIdResolver,
    fallbackSources: readonly ThirdPartySource[] = defaultFallbackSources,
  ) {
    // 复制输入数组防止设置页面或测试调用方随后原地修改优先级，导致同一预览响应内部前后不一致。
    this.fallbackSources = [...fallbackSources];
  }

  /** 并行确认独立地区但保留输入顺序，保证管理员按所选地区顺序查看和确认来源。 */
  public async create(candidates: OfficialPriceIdCandidate[]): Promise<SubscriptionRegionPreview[]> {
    return Promise.all(candidates.map(async (candidate) => this.toPreview(candidate, await this.officialPriceIds.resolve(candidate))));
  }

  /** 将官方成功、可第三方回退和无来源三种状态明确区分，避免无官方 ID 时被误显示为官方价格。 */
  private toPreview(candidate: OfficialPriceIdCandidate, resolution: OfficialPriceIdResolution): SubscriptionRegionPreview {
    if (resolution.status === "official-available") {
      return {
        regionCode: candidate.regionCode,
        officialStatus: resolution.status,
        officialPriceId: resolution.officialPriceId,
        fallbackSources: [...this.fallbackSources],
        canMonitor: true,
        message: "官方价格可用",
      };
    }
    if (this.fallbackSources.length > 0) {
      return {
        regionCode: candidate.regionCode,
        officialStatus: resolution.status,
        officialPriceId: null,
        fallbackSources: [...this.fallbackSources],
        canMonitor: true,
        message: `官方价格 ID 未确认，将使用第三方：${this.fallbackSources.join(" → ")}`,
      };
    }
    return {
      regionCode: candidate.regionCode,
      officialStatus: resolution.status,
      officialPriceId: null,
      fallbackSources: [],
      canMonitor: false,
      message: "无可用价格来源，不会监控此区",
    };
  }
}
