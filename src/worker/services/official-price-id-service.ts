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
 * 香港 eShop 的完整游戏、追加内容和组合商品分别使用 titles/aocs/bundles 路径，但公开价格 API 都接受路径中的纯数字 ID。
 * 正则只接受精确地区、语言和资源类型，避免把相似 URL、其他服 URL 或任意数字片段作为可采集价格映射。
 */
const hongKongEshopPath = /^\/HK\/zh\/(?:titles|aocs|bundles)\/(\d+)\/?$/;

/**
 * 从已确认商品链接取得已准入地区的价格 ID 后立即调用官方价格提供方二次验证。JP 和 HK 各自只有一套经过 ADR-002 验证的规则，
 * 其他地区返回可解释的不可用状态并等待专用解析器，而不是根据相似 URL 猜测跨区 ID。
 */
export class OfficialPriceIdService {
  public constructor(private readonly officialProvider: PriceProvider) {}

  public async resolve(candidate: OfficialPriceIdCandidate): Promise<OfficialPriceIdResolution> {
    const officialPriceId = extractOfficialPriceId(candidate);
    // 未通过地区/货币准入时不得尝试 URL 解析或网络验证，避免未来相同格式的链接被错误解释为 JP/HK 官方价格 ID。
    if (officialPriceId === undefined) return unavailable("unsupported-region");
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
 * 根据已经审核的地区/货币组合选择专用价格 ID 提取器。`undefined` 表示该地区尚无公开 API 准入，
 * `null` 表示链接不是本区精确官方格式；二者必须区分，供订阅前来源预览给出安全且可操作的提示。
 */
function extractOfficialPriceId(candidate: OfficialPriceIdCandidate): string | null | undefined {
  if (candidate.regionCode === "JP" && candidate.currency === "JPY") return extractJapanesePriceId(candidate.productUrl);
  if (candidate.regionCode === "HK" && candidate.currency === "HKD") return extractHongKongPriceId(candidate.productUrl);
  return undefined;
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

/**
 * 只接受 HTTPS 香港 eShop 的 titles/aocs/bundles 精确路径，且不接受查询或片段参数。价格 ID 是地区绑定标识，
 * 所以即使查询参数含有数字也不能作为候选，避免管理员粘贴分享、跳转或跨服链接时误绑定错误商品价格。
 */
function extractHongKongPriceId(productUrl: string): string | null {
  try {
    const url = new URL(productUrl);
    if (url.protocol !== "https:" || url.hostname !== "ec.nintendo.com" || url.search !== "" || url.hash !== "") return null;
    return url.pathname.match(hongKongEshopPath)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 统一封装无官方 ID 的安全状态，避免调用方遗漏 `officialPriceId: null` 而把旧 ID 带入预览。 */
function unavailable(reason: Extract<OfficialPriceIdResolution, { status: "official-id-unavailable" }> ["reason"]): OfficialPriceIdResolution {
  return { status: "official-id-unavailable", officialPriceId: null, reason };
}
