import type { OfficialProductCandidate, OfficialProductSearch, OfficialSearchResult, RegionalProductMatchSource } from "../../shared/domain";
import {
  isUniqueAutomaticRegionalCandidate,
} from "./official-product-discovery-service";
import type { OfficialPriceIdResolution, OfficialPriceIdService } from "./official-price-id-service";

/** 日区价格 ID 服务的最小接口；窄依赖可让确认测试验证官方双接口而无需构造真实网络适配器。 */
type OfficialPriceIdResolver = Pick<OfficialPriceIdService, "resolve">;

/** 日区 My Nintendo Store 下载软件路径只能指向软件数字 ID；末尾斜杠是展示差异，不属于商品身份。 */
const japaneseDownloadPath = /^\/item\/software\/D(\d+)\/?$/;

/**
 * 普通日区游戏、组合商品与 DLC 的双官方接口适配层。My Nintendo Store 商品页可能向 Worker 返回排队或动态外壳，
 * 因而此服务以官方软件搜索 API 取得身份字段，并以官方价格 API 证明同一标题 ID 当前在 JP/JPY 上架。
 * 升级包必须由上层关系服务复核根商品与 Browser URL，本服务在任何外部调用前拒绝，防止旧双 API 绕过关系证明。
 */
export class JapaneseSubscriptionConfirmationService {
  public constructor(
    private readonly search: Pick<OfficialProductSearch, "search">,
    private readonly officialPriceIds: OfficialPriceIdResolver,
  ) {}

  /**
   * 从当次官方搜索重建待保存的日区候选。搜索词使用待保存候选的官方日区标题：英文默认区标题未必能返回
   * 已本地化的日区组合商品；随后仍要求同一精确官方 URL 在响应中出现，因而浏览器改写标题并不能扩大确认范围。
   */
  public async resolve(
    anchor: OfficialProductCandidate,
    candidate: OfficialProductCandidate,
    matchSource: RegionalProductMatchSource,
  ): Promise<OfficialProductCandidate | null> {
    if (candidate.productType === "upgrade-pack") return null;
    const titleId = candidate.regionCode === "JP" ? extractJapaneseTitleId(candidate.productUrl) : null;
    if (titleId === null) return null;

    try {
      const searchResult = await this.search.search("JP", candidate.canonicalTitle, new AbortController().signal);
      if (searchResult.status !== "available") return null;

      const verified = await this.confirmSearchResult(anchor, titleId, searchResult, matchSource);
      if (verified) return verified;
      return matchSource === "automatic" ? this.resolveAutomaticLocalizedFallback(anchor, titleId, searchResult) : null;
    } catch {
      // 官方网络、页面结构或价格接口暂时异常只转换为安全的“无法确认”；不把响应正文、URL 或堆栈泄漏给管理员页面。
      return null;
    }
  }

  /**
   * 在一次官方搜索结果中确认目标日区标题 ID。搜索适配器已验证下载版 id/nsuid 与 URL 映射；这里以同一数字
   * 标题 ID 而非原始字符串比对，因为 Store URL 末尾斜杠可能被前端旧状态或人工链接省略，但 ID、地区和价格 API
   * 才是安全身份边界。
   */
  private async confirmSearchResult(
    anchor: OfficialProductCandidate,
    titleId: string,
    searchResult: Extract<OfficialSearchResult, { status: "available" }>,
    matchSource: RegionalProductMatchSource,
  ): Promise<OfficialProductCandidate | null> {
    const verified = searchResult.candidates.find((option) => extractJapaneseTitleId(option.productUrl) === titleId) ?? null;
    if (!verified || verified.regionCode !== "JP" || verified.currency !== "JPY") return null;

    // `automatic` 是更高权限的审计来源，不能由浏览器单独声明；必须从同次官方结果再次得到唯一严格或本地化身份。
    if (matchSource === "automatic" && !isUniqueAutomaticRegionalCandidate(anchor, verified, searchResult.candidates)) return null;

    const price = await this.officialPriceIds.resolve(verified);
    return hasVerifiedJapaneseOfficialPriceId(price, titleId) ? verified : null;
  }

  /**
   * automatic 保存确认的受限兜底：当提交标题仍是默认区英文名时，日区官方搜索可能只返回同系列本体。
   * 此时只能从同发行商、同拉丁系列标记的官方日区结果中提取唯一片假名别名，再额外查一次；随后仍回到同一标题 ID、
   * 唯一本地化身份和价格 API 校验，不能把该兜底扩展成人工链接或任意翻译搜索。
   */
  private async resolveAutomaticLocalizedFallback(
    anchor: OfficialProductCandidate,
    titleId: string,
    initialSearchResult: Extract<OfficialSearchResult, { status: "available" }>,
  ): Promise<OfficialProductCandidate | null> {
    const alias = readUniqueJapaneseSeriesAlias(anchor, initialSearchResult.candidates);
    if (alias === null) return null;
    const fallback = await this.search.search("JP", alias, new AbortController().signal);
    return fallback.status === "available" ? this.confirmSearchResult(anchor, titleId, fallback, "automatic") : null;
  }
}

/**
 * 从官方 URL 提取日区数字标题 ID。此函数只放宽末尾斜杠：子路径、查询拼接、错误主机或非数字 ID
 * 仍会被拒绝，因为任何跨越官方路径边界的宽松提取都会允许一个页面 URL 与另一商品的官方价格响应错误绑定。
 */
function extractJapaneseTitleId(productUrl: string): string | null {
  try {
    const url = new URL(productUrl);
    if (url.protocol !== "https:" || url.hostname !== "store-jp.nintendo.com" || url.search !== "" || url.hash !== "") return null;
    return japaneseDownloadPath.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 价格 ID 服务内部已经验证价格 API 的 JP、JPY、onsale 与回显标题 ID 契约；本层仍将其结果与 URL 标题 ID 比较，
 * 以防未来适配器错误或异常替身把另一条日区官方价格标记为可用，造成两个合法商品被错误绑定。
 */
function hasVerifiedJapaneseOfficialPriceId(resolution: OfficialPriceIdResolution, expectedTitleId: string): boolean {
  return resolution.status === "official-available" && resolution.officialPriceId === expectedTitleId;
}

/**
 * 只从已验证官方搜索结果中提取一个日文系列别名。条件刻意与跨区发现保持一致：允许同系列本体作为别名来源，
 * 但必须同为日区官方 URL、发行商一致、拉丁主标题标记一致，防止英文提交标题把搜索面扩展到同发行商其它游戏。
 */
function readUniqueJapaneseSeriesAlias(anchor: OfficialProductCandidate, candidates: OfficialProductCandidate[]): string | null {
  const aliases = [...new Set(candidates
    .filter((option) => isJapaneseSeriesSearchAnchor(anchor, option))
    .map((option) => readJapaneseSeriesAlias(option.canonicalTitle))
    .filter((alias): alias is string => alias !== null))];
  return aliases.length === 1 ? aliases[0] : null;
}

/** 判断一条日区结果能否作为片假名别名来源；商品类型可不同，因为英文组合商品搜索常先命中日区本体。 */
function isJapaneseSeriesSearchAnchor(anchor: OfficialProductCandidate, option: OfficialProductCandidate): boolean {
  return option.regionCode === "JP"
    && extractJapaneseTitleId(option.productUrl) !== null
    && anchor.publisher !== null
    && option.publisher !== null
    && normalizeTitle(anchor.publisher) === normalizeTitle(option.publisher)
    && latinTitleMarker(anchor.canonicalTitle) !== null
    && latinTitleMarker(anchor.canonicalTitle) === latinTitleMarker(option.canonicalTitle);
}

/**
 * 从本地化标题中提取唯一片假名系列词，并统一全角数字。它不是翻译器；没有唯一片假名片段时必须失败闭合，
 * 避免把宽泛日文词带入最终保存确认。
 */
function readJapaneseSeriesAlias(title: string): string | null {
  const aliases = [...new Set(title.normalize("NFKC").match(/[\p{Script=Katakana}ー]+(?:\s*\d+)?/gu) ?? [])]
    .map((alias) => alias.replace(/\s+/g, ""))
    .filter((alias) => /\p{Script=Katakana}/u.test(alias));
  return aliases.length === 1 ? aliases[0] : null;
}

/**
 * 从跨语言标题中读取主系列标记；NFKC 会统一全角数字与商标排版，使 `Overcooked® 2` 与
 * `Overcooked! ２` 都落到同一个 `overcooked2`，但纯版本词或纯数字不会被当作游戏身份。
 */
function latinTitleMarker(title: string): string | null {
  const matched = title.normalize("NFKC").toLocaleLowerCase().match(/[a-z]{3,}(?:[^\p{L}\p{N}]+\d+)+/u)?.[0];
  if (!matched) return null;
  const normalized = matched.replace(/[^a-z0-9]+/gu, "");
  return /[a-z]{3,}/u.test(normalized) && /\d/u.test(normalized) ? normalized : null;
}

/** 标题和发行商的比较只用于瞬时身份信号，不修改任天堂官方标题展示值。 */
function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
