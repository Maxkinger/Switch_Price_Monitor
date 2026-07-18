import type { OfficialProductCandidate, OfficialProductSearch, OfficialSearchResult, RegionCode } from "../../shared/domain";
import { isOfficialNintendoProductUrl, type OfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";

/**
 * 发现服务只读取默认搜索区和启用地区。两者均由服务端设置保存，
 * 可防止浏览器缓存、篡改请求或旧前端把任天堂检索扩展到管理员未启用的地区。
 */
export interface DiscoverySettingsReader {
  get(): Promise<{ defaultSearchRegion: RegionCode; enabledRegions: RegionCode[] } | null>;
}

/** 每个已选默认区商品在另一启用地区的确认状态；候选永远绑定 `candidateKey`，不会在多选时串给其他游戏。 */
export type RegionResolution =
  | { candidateKey: string; regionCode: RegionCode; status: "automatic"; candidate: OfficialProductCandidate }
  | { candidateKey: string; regionCode: RegionCode; status: "needs-manual-selection"; candidates: OfficialProductCandidate[]; featuredCandidateCount: number }
  | { candidateKey: string; regionCode: RegionCode; status: "needs-manual-link" };

/** 未初始化设置或官方链接无法验证时使用受控领域错误，路由可返回中文 422/409 而不回显任天堂响应。 */
export class ProductDiscoveryError extends Error {}

/**
 * 把默认区官网名称搜索、官方链接解析和跨区匹配集中在服务端。浏览器只提交查询或官方 URL，
 * 服务始终从保存的设置取得默认区，并且不写入 D1，管理员取消向导不会留下半成品游戏或地区商品。
 */
export class OfficialProductDiscoveryService {
  public constructor(
    private readonly settings: DiscoverySettingsReader,
    private readonly search: OfficialProductSearch,
    private readonly pages: OfficialNintendoProductPageResolver,
  ) {}

  /** 读取已保存的默认搜索区；浏览器参数没有地区字段，因此不能绕过管理员设置查询另一服索引。 */
  public async searchDefaultRegion(query: string): Promise<OfficialSearchResult> {
    const settings = await this.settings.get();
    if (!settings) throw new ProductDiscoveryError("应用尚未完成初始化。");
    return this.search.search(settings.defaultSearchRegion, query, new AbortController().signal);
  }

  /**
   * 验证一个指定地区的任天堂官方商品链接。解析器会在网络请求前检查地区主机和路径白名单；
   * 返回 null 表示公开页面不能证明身份，服务以可读错误终止，绝不把浏览器自报标题或币种当作候选。
   */
  public async resolveOfficialLink(regionCode: RegionCode, productUrl: string): Promise<OfficialProductCandidate> {
    const candidate = await this.pages.resolve(regionCode, productUrl, new AbortController().signal);
    if (!candidate) throw new ProductDiscoveryError("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");
    return candidate;
  }

  /**
   * 每个已选游戏独立检查保存设置中的其他启用地区。浏览器没有地区参数，避免旧页面或篡改请求扩大官方检索范围；
   * 自动匹配必须同时吻合规范化标题、受控类型和双方均有的发行商，没有唯一候选时才交由管理员人工确认。
   */
  public async resolveRegions(selected: OfficialProductCandidate[]): Promise<RegionResolution[]> {
    const settings = await this.settings.get();
    if (!settings) throw new ProductDiscoveryError("应用尚未完成初始化。");
    return Promise.all(selected.flatMap((candidate) => settings.enabledRegions
      .filter((regionCode) => regionCode !== candidate.regionCode)
      .map(async (regionCode) => this.matchRegion(candidate, regionCode))));
  }

  /**
   * 为一个游戏/地区组合选择安全的自动候选或人工确认状态，绝不按数组位置把候选分配给其他游戏。
   * 自动确认和人工选择的信任边界不同：前者只能使用唯一严格身份，而后者允许管理员审计本地化标题；
   * 不过两者都必须来自该地区的官方 URL 且属于同一受控商品类型，不能把搜索摘要或任意网页当作可保存映射。
   */
  private async matchRegion(candidate: OfficialProductCandidate, regionCode: RegionCode): Promise<RegionResolution> {
    const candidateKey = officialCandidateKey(candidate);
    const result = await this.search.search(regionCode, candidate.canonicalTitle, new AbortController().signal);
    if (result.status === "unavailable") return { candidateKey, regionCode, status: "needs-manual-link" };

    const sameTypeCandidates = verifiedSameTypeCandidates(candidate, regionCode, result.candidates);
    const matches = sameTypeCandidates.filter((option) => hasSameOfficialIdentity(candidate, option));
    if (matches.length === 1) return { candidateKey, regionCode, status: "automatic", candidate: matches[0] };
    const localizedMatches = sameTypeCandidates.filter((option) => localizedIdentityRelevance(candidate, option) === 2);
    if (localizedMatches.length === 1) return { candidateKey, regionCode, status: "automatic", candidate: localizedMatches[0] };
    const rankedCandidates = rankRegionalCandidates(candidate, sameTypeCandidates);
    if (rankedCandidates.length === 0) return { candidateKey, regionCode, status: "needs-manual-link" };

    // 推荐数量由 Worker 根据已验证的官方字段计算，浏览器只能据此折叠显示，不能依靠标题或价格重新推断匹配关系。
    const relatedCandidateCount = rankedCandidates.filter((option) => localizedIdentityRelevance(candidate, option) > 0).length;
    return {
      candidateKey,
      regionCode,
      status: "needs-manual-selection",
      candidates: rankedCandidates,
      featuredCandidateCount: relatedCandidateCount > 0 ? relatedCandidateCount : Math.min(3, rankedCandidates.length),
    };
  }
}

/**
 * 将外部官方搜索结果再次收窄为本区、同类型且符合商品页白名单的候选，并用标题及 URL 生成稳定顺序。
 * 搜索适配器已负责解析，但其响应仍是外部输入；这里防御性过滤可避免适配器变更或异常数据把跨区/非官网 URL
 * 带到管理员操作界面。人工选择可接受本地化标题，所以不能在此要求标题或发行商相同。
 */
function verifiedSameTypeCandidates(
  anchor: OfficialProductCandidate,
  regionCode: RegionCode,
  candidates: OfficialProductCandidate[],
): OfficialProductCandidate[] {
  return candidates
    .filter((option) => option.regionCode === regionCode
      && option.productType === anchor.productType
      && isOfficialNintendoProductUrl(regionCode, option.productUrl))
    // `filter` 已创建新数组，因此在项目当前 ES 目标下使用 `sort` 也不会修改外部搜索响应或其他地区的候选顺序。
    .sort(compareOfficialCandidates);
}

/**
 * 标题相同的官方候选再以完整商品 URL 断开平局，保证跨请求的渲染顺序确定。
 * 这不参与身份判断；它只防止上游检索的非稳定排序使前端选择状态在刷新后映射到另一张候选卡。
 */
function compareOfficialCandidates(left: OfficialProductCandidate, right: OfficialProductCandidate): number {
  const titleOrder = normalizeTitle(left.canonicalTitle).localeCompare(normalizeTitle(right.canonicalTitle));
  return titleOrder !== 0 ? titleOrder : left.productUrl.localeCompare(right.productUrl);
}

/**
 * 本地化候选先按可审计的官方身份信号排序，再沿用标题和 URL 的稳定顺序。相关度只决定人工界面的展示优先级；
 * 唯一的最高相关度候选才可自动确认，避免日文别名、同名 DLC 或营销标题被浏览器或搜索顺序误配。
 */
function rankRegionalCandidates(anchor: OfficialProductCandidate, candidates: OfficialProductCandidate[]): OfficialProductCandidate[] {
  return [...candidates].sort((left, right) => {
    const relevanceOrder = localizedIdentityRelevance(anchor, right) - localizedIdentityRelevance(anchor, left);
    return relevanceOrder !== 0 ? relevanceOrder : compareOfficialCandidates(left, right);
  });
}

/** 候选键只使用默认区的地区与官方 URL；标题可能随语言变化，URL 是当前向导内更稳定且已验证的身份来源。 */
export function officialCandidateKey(candidate: Pick<OfficialProductCandidate, "regionCode" | "productUrl">): string {
  return `${candidate.regionCode}:${candidate.productUrl}`;
}

/** 标题比较忽略大小写及重复空白；发行商只有双方都有时才作为防止同名商品误配的附加约束。 */
function hasSameOfficialIdentity(left: OfficialProductCandidate, right: OfficialProductCandidate): boolean {
  if (normalizeTitle(left.canonicalTitle) !== normalizeTitle(right.canonicalTitle) || left.productType !== right.productType) return false;
  return left.publisher === null || right.publisher === null || normalizeTitle(left.publisher) === normalizeTitle(right.publisher);
}

/**
 * 为本地化标题计算有限的官方身份相关度。2 表示可用于自动确认的完整独立证据，1 仅表示应优先展示；
 * 发行商缺失、类型差异或只共享泛化版本文案时返回 0，防止把相同引擎版本、同名系列或附加内容误当作同一商品。
 */
function localizedIdentityRelevance(anchor: OfficialProductCandidate, option: OfficialProductCandidate): 0 | 1 | 2 {
  if (anchor.productType !== option.productType || anchor.publisher === null || option.publisher === null || normalizeTitle(anchor.publisher) !== normalizeTitle(option.publisher)) return 0;
  const anchorTitle = latinTitleMarker(anchor.canonicalTitle);
  if (anchorTitle === null || anchorTitle !== latinTitleMarker(option.canonicalTitle)) return 0;
  const anchorEdition = editionMarker(anchor.canonicalTitle);
  return anchorEdition !== null && anchorEdition === editionMarker(option.canonicalTitle) ? 2 : 1;
}

/**
 * 从不同语言的官方标题中提取首个同时包含三个以上拉丁字母和数字的主标题标记。
 * Unicode NFKC 会统一全角数字与商标排版，例如 `Overcooked® 2` 和 `Overcooked! ２` 都成为 `overcooked2`；
 * 纯版本词或纯数字不足以作为游戏身份，因而返回 null，不能触发自动确认。
 */
function latinTitleMarker(title: string): string | null {
  const matched = title.normalize("NFKC").toLocaleLowerCase().match(/[a-z]{3,}(?:[^\p{L}\p{N}]+\d+)+/u)?.[0];
  if (!matched) return null;
  const normalized = matched.replace(/[^a-z0-9]+/gu, "");
  return /[a-z]{3,}/u.test(normalized) && /\d/u.test(normalized) ? normalized : null;
}

/**
 * 版本标记是本地化自动确认的第二项独立信号。当前只接受明确的 Switch 2 Edition 英文官方标记；
 * 未识别的新版本命名必须降级为人工确认，而不是猜测其等价关系。
 */
function editionMarker(title: string): string | null {
  return /nintendo\s+switch\s*2\s+edition/iu.test(title.normalize("NFKC")) ? "nintendo-switch-2-edition" : null;
}

/** 规范化只用于瞬时自动匹配，不覆盖或修改管理员最终确认的官方标题。 */
function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
