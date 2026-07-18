import type { OfficialProductCandidate, OfficialProductSearch, RegionalProductMatchSource } from "../../shared/domain";
import {
  isUniqueAutomaticRegionalCandidate,
} from "./official-product-discovery-service";
import type { OfficialPriceIdResolution, OfficialPriceIdService } from "./official-price-id-service";

/** 日区价格 ID 服务的最小接口；窄依赖可让确认测试验证官方双接口而无需构造真实网络适配器。 */
type OfficialPriceIdResolver = Pick<OfficialPriceIdService, "resolve">;

/** 日区 My Nintendo Store 下载软件 URL 只能使用该精确路径；捕获的数字才是价格 API 所用的标题 ID，路径前缀 D 不可传入 API。 */
const japaneseDownloadUrl = /^https:\/\/store-jp\.nintendo\.com\/item\/software\/D(\d+)\/$/;

/**
 * 日区最终确认专用的双官方接口适配层。My Nintendo Store 商品页可能向 Worker 返回排队或动态外壳，
 * 因而此服务以官方软件搜索 API 取得身份字段，并以官方价格 API 证明同一标题 ID 当前在 JP/JPY 上架；
 * 任一证据缺失都返回 null，调用方必须拒绝整个 D1 批次，绝不能回退采信浏览器候选。
 */
export class JapaneseSubscriptionConfirmationService {
  public constructor(
    private readonly search: Pick<OfficialProductSearch, "search">,
    private readonly officialPriceIds: OfficialPriceIdResolver,
  ) {}

  /**
   * 从当次官方搜索重建待保存的日区候选。跨区日区候选使用已经重新验证过的默认区锚点标题作为搜索词，
   * 这样浏览器无法通过改写日文标题扩大自动匹配范围；日区作为默认区时没有跨区锚点，才使用其自身标题。
   */
  public async resolve(
    anchor: OfficialProductCandidate,
    candidate: OfficialProductCandidate,
    matchSource: RegionalProductMatchSource,
  ): Promise<OfficialProductCandidate | null> {
    const titleId = candidate.regionCode === "JP" ? extractJapaneseTitleId(candidate.productUrl) : null;
    if (titleId === null) return null;

    try {
      const query = anchor.regionCode === "JP" ? candidate.canonicalTitle : anchor.canonicalTitle;
      const searchResult = await this.search.search("JP", query, new AbortController().signal);
      if (searchResult.status !== "available") return null;

      // 搜索适配器已验证下载版 id/nsuid 与 URL 映射；这里仍要求完全相同 URL，防止相邻标题或同名版本替换管理员所选项。
      const verified = searchResult.candidates.find((option) => option.productUrl === candidate.productUrl) ?? null;
      if (!verified || verified.regionCode !== "JP" || verified.currency !== "JPY") return null;

      // `automatic` 是更高权限的审计来源，不能由浏览器单独声明；必须从同次官方结果再次得到唯一严格或本地化身份。
      if (matchSource === "automatic" && !isUniqueAutomaticRegionalCandidate(anchor, verified, searchResult.candidates)) return null;

      const price = await this.officialPriceIds.resolve(verified);
      return hasVerifiedJapaneseOfficialPriceId(price, titleId) ? verified : null;
    } catch {
      // 官方网络、页面结构或价格接口暂时异常只转换为安全的“无法确认”；不把响应正文、URL 或堆栈泄漏给管理员页面。
      return null;
    }
  }
}

/**
 * 从精确官方 URL 提取日区数字标题 ID。此函数不接受子路径、查询拼接、错误主机或非数字 ID，
 * 因为任何宽松提取都会允许一个页面 URL 与另一商品的官方价格响应错误绑定。
 */
function extractJapaneseTitleId(productUrl: string): string | null {
  return japaneseDownloadUrl.exec(productUrl)?.[1] ?? null;
}

/**
 * 价格 ID 服务内部已经验证价格 API 的 JP、JPY、onsale 与回显标题 ID 契约；本层仍将其结果与 URL 标题 ID 比较，
 * 以防未来适配器错误或异常替身把另一条日区官方价格标记为可用，造成两个合法商品被错误绑定。
 */
function hasVerifiedJapaneseOfficialPriceId(resolution: OfficialPriceIdResolution, expectedTitleId: string): boolean {
  return resolution.status === "official-available" && resolution.officialPriceId === expectedTitleId;
}
