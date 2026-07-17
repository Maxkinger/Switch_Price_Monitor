import type { PriceProvider, ProductType, RegionalProduct } from "../providers/types";

/**
 * 商品确认界面提交的最小公开候选信息。它尚未写入 D1；管理员看到来源预览并确认后，
 * 后续持久化流程才会创建地区商品，因此取消操作不会留下错误价格 ID 或半成品订阅。
 */
export interface OfficialPriceIdCandidate {
  regionCode: RegionalProduct["regionCode"];
  currency: string;
  productUrl: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
}

/** 成功只返回经过官方接口二次验证的本区 ID；失败原因供订阅前来源预览显示，不暴露外部响应详情。 */
export type OfficialPriceIdResolution =
  | { status: "official-available"; officialPriceId: string }
  | {
    status: "official-id-unavailable";
    officialPriceId: null;
    reason: "unsupported-region" | "unrecognized-url" | "official-verification-failed";
  };

/** 日区商品页的已验证路径格式；前缀 D 仅属于页面地址，公开价格 API 使用去掉该前缀后的数字 ID。 */
const japaneseStorePath = /^\/item\/software\/D(\d+)\/?$/;

/**
 * 从已确认商品链接取得日区价格 ID 后立即调用官方价格提供方二次验证。服务刻意只实现 ADR-002 已验证的日区规则，
 * 其他地区返回可解释的不可用状态并等待专用解析器，而不是根据相似 URL 猜测跨区 ID。
 */
export class OfficialPriceIdService {
  public constructor(private readonly officialProvider: PriceProvider) {}

  public async resolve(candidate: OfficialPriceIdCandidate): Promise<OfficialPriceIdResolution> {
    // 当前公开价格接口的地区/货币契约仅为 JP/JPY；先拒绝其他服可避免解析恶意或碰巧相似的 URL。
    if (candidate.regionCode !== "JP" || candidate.currency !== "JPY") return unavailable("unsupported-region");

    const officialPriceId = extractJapanesePriceId(candidate.productUrl);
    if (officialPriceId === null) return unavailable("unrecognized-url");

    const product: RegionalProduct = { id: "preview", ...candidate, officialPriceId };
    try {
      const result = await this.officialProvider.fetch(product, new AbortController().signal);
      // 除价格本身外还必须回显相同 ID，确保错误实现的提供方不能仅凭任意官方结果把候选标为可用。
      return result?.source === "official" && result.officialPriceId === officialPriceId
        ? { status: "official-available", officialPriceId }
        : unavailable("official-verification-failed");
    } catch {
      // 预览阶段不向管理员回显网络、响应或堆栈信息；失败状态会让其清楚看到第三方回退而非误判为官方可用。
      return unavailable("official-verification-failed");
    }
  }
}

/**
 * 只接受 HTTPS 的官方日区主机和精确软件路径。URL 解析失败、子域名伪装或额外路径都不提取 ID，
 * 防止管理员粘贴的任意地址把数字片段伪装为官方商品映射。
 */
function extractJapanesePriceId(productUrl: string): string | null {
  try {
    const url = new URL(productUrl);
    if (url.protocol !== "https:" || url.hostname !== "store-jp.nintendo.com") return null;
    return url.pathname.match(japaneseStorePath)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 统一封装无官方 ID 的安全状态，避免调用方遗漏 `officialPriceId: null` 而把旧 ID 带入预览。 */
function unavailable(reason: Extract<OfficialPriceIdResolution, { status: "official-id-unavailable" }> ["reason"]): OfficialPriceIdResolution {
  return { status: "official-id-unavailable", officialPriceId: null, reason };
}
