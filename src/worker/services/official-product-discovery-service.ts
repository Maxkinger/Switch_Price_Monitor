import type { OfficialProductCandidate, OfficialProductSearch, OfficialSearchResult, RegionCode } from "../../shared/domain";
import {
  isOfficialNintendoProductUrl,
  type OfficialNintendoProductPageResolver,
  type OfficialNintendoRelatedProductReference,
  type OfficialNintendoRelatedProductResolver,
} from "../providers/official-nintendo-product-page";

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
 * 不涉及港区关系发现的调用方使用安全空实现；它只返回“无法证明”，不会发网或产生候选。
 * 生产入口会显式注入真实解析器，此默认值主要保持既有单区/日区测试和独立服务使用者的最小权限。
 */
const unavailableRelatedProductResolver: OfficialNintendoRelatedProductResolver = {
  resolveRelated: async () => null,
};

/**
 * 把默认区官网名称搜索、官方链接解析和跨区匹配集中在服务端。浏览器只提交查询或官方 URL，
 * 服务始终从保存的设置取得默认区，并且不写入 D1，管理员取消向导不会留下半成品游戏或地区商品。
 */
export class OfficialProductDiscoveryService {
  public constructor(
    private readonly settings: DiscoverySettingsReader,
    private readonly search: OfficialProductSearch,
    private readonly pages: OfficialNintendoProductPageResolver,
    private readonly related: OfficialNintendoRelatedProductResolver = unavailableRelatedProductResolver,
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
   * 最终订阅确认可用此方法重新执行同一套官方发现与唯一性规则，而不是信任浏览器提交的 automatic 标记。
   * 只有当本次结果仍为唯一自动候选且官方 URL 完全相同才返回 true；地区涨落、页面结构变化或出现第二候选都会拒绝写入。
   */
  public async verifyAutomaticRegionalCandidate(anchor: OfficialProductCandidate, candidate: OfficialProductCandidate): Promise<boolean> {
    if (anchor.regionCode === candidate.regionCode) return false;
    const resolution = await this.matchRegion(anchor, candidate.regionCode);
    return resolution.status === "automatic" && resolution.candidate.productUrl === candidate.productUrl;
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

    const initialSameTypeCandidates = verifiedSameTypeCandidates(candidate, regionCode, result.candidates);
    const japaneseCandidates = initialSameTypeCandidates.length > 0
      ? initialSameTypeCandidates
      : await this.searchJapaneseLocalizedBundleFallback(candidate, regionCode, result.candidates);
    const sameTypeCandidates = japaneseCandidates.length > 0
      ? japaneseCandidates
      : await this.searchHongKongRelatedProductFallback(candidate, regionCode);
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

  /**
   * 日区官网常以日文系列名索引组合商品，英文美食家版查询可能只返回同系列本体。仅当首次结果没有任何同类型候选时，
   * 才从一条已验证、同发行商且同拉丁系列标记的官方日区结果提取唯一日文别名，并额外查询一次；不接收浏览器文本、
   * 不枚举多个别名，避免把回退检索扩展为不受控制的全站搜索或误配同发行商的其他商品。
   */
  private async searchJapaneseLocalizedBundleFallback(
    anchor: OfficialProductCandidate,
    regionCode: RegionCode,
    initialCandidates: OfficialProductCandidate[],
  ): Promise<OfficialProductCandidate[]> {
    if (regionCode !== "JP") return [];
    const aliases = [...new Set(initialCandidates
      .filter((option) => isJapaneseSeriesSearchAnchor(anchor, option))
      .map((option) => readJapaneseSeriesAlias(option.canonicalTitle))
      .filter((alias): alias is string => alias !== null))];
    if (aliases.length !== 1) return [];

    const fallback = await this.search.search("JP", aliases[0], new AbortController().signal);
    // 第二次请求同样只信任官方适配器的可用响应；失败时不把第一次不同类型结果泄漏到人工选择区。
    return fallback.status === "available" ? verifiedSameTypeCandidates(anchor, "JP", fallback.candidates) : [];
  }

  /**
   * 港区普通名称搜索不直接收录所有组合商品和升级包。仅当首轮没有同类型结果且锚点含已审核后缀时，
   * 才执行一次基础标题搜索；返回 1–5 个官方 titles 本体后逐个读取一层关系，并重新解析每个同类型关联商品自己的详情。
   * 任一根关系或详情不完整都整批回退，防止利用部分集合得出错误的唯一自动匹配。
   */
  private async searchHongKongRelatedProductFallback(
    anchor: OfficialProductCandidate,
    regionCode: RegionCode,
  ): Promise<OfficialProductCandidate[]> {
    if (regionCode !== "HK") return [];
    const baseTitle = readHongKongBaseTitle(anchor);
    if (baseTitle === null) return [];

    const baseSearch = await this.search.search("HK", baseTitle, new AbortController().signal);
    if (baseSearch.status !== "available") return [];
    const roots = deduplicateHongKongBaseRoots(baseSearch.candidates);
    if (roots.length < 1 || roots.length > 5) return [];

    const relationsByUrl = new Map<string, OfficialNintendoRelatedProductReference>();
    try {
      for (const root of roots) {
        const relations = await this.related.resolveRelated("HK", root.productUrl, new AbortController().signal);
        if (relations === null) return [];
        for (const relation of relations) {
          if (relation.regionCode !== "HK"
            || relation.productType !== anchor.productType
            || !isOfficialNintendoProductUrl("HK", relation.productUrl)) continue;
          relationsByUrl.set(relation.productUrl, relation);
        }
      }

      const verified: OfficialProductCandidate[] = [];
      for (const relation of relationsByUrl.values()) {
        const candidate = await this.pages.resolve("HK", relation.productUrl, new AbortController().signal);
        // 关系只是发现线索；地区、URL、类型和发行商均须由目标商品自己的官方详情重新证明，且不能从默认区或本体继承。
        if (candidate === null
          || candidate.regionCode !== "HK"
          || candidate.productUrl !== relation.productUrl
          || candidate.productType !== anchor.productType
          || candidate.publisher === null
          || !isOfficialNintendoProductUrl("HK", candidate.productUrl)) return [];
        verified.push(candidate);
      }
      return verified.sort(compareOfficialCandidates);
    } catch {
      // 任天堂关系或详情的传输失败不应使整个向导报出底层网络信息；安全降级为人工官方链接，不产生任何订阅写入。
      return [];
    }
  }
}

/**
 * 只从已确认的英文版本后缀导出一次港区基础标题。当前支持 Gourmet Edition 和 Switch 2 Upgrade Pack；
 * 未识别组合名、普通 DLC 或截取后为空都返回 null，避免以任意分隔符宽泛搜索整站。
 */
function readHongKongBaseTitle(anchor: OfficialProductCandidate): string | null {
  // NFKC 只用于瞬时后缀识别，可统一全角标点与数字；保存和展示仍保留任天堂返回的原始官方标题。
  const normalizedTitle = anchor.canonicalTitle.normalize("NFKC").trim();
  const suffix = anchor.productType === "bundle"
    ? /\s*[-–—:：]\s*gourmet\s+edition\s*$/iu
    : anchor.productType === "upgrade-pack"
      ? /\s*[-–—]?\s*nintendo\s+switch\s*2\s+edition\s+upgrade\s+pack\s*$/iu
      : null;
  if (suffix === null || !suffix.test(normalizedTitle)) return null;
  const baseTitle = normalizedTitle.replace(suffix, "").trim();
  return baseTitle.length > 0 ? baseTitle : null;
}

/**
 * 基础搜索结果只接受港区 game 类型和精确 titles 数字 URL，并按 URL 去重后稳定排序；
 * 搜索摘要中的发行商不是关系展开凭据，最终关联商品仍必须从自己的详情读取发行商。
 */
function deduplicateHongKongBaseRoots(candidates: OfficialProductCandidate[]): OfficialProductCandidate[] {
  const roots = new Map<string, OfficialProductCandidate>();
  for (const candidate of candidates) {
    if (candidate.regionCode !== "HK" || candidate.productType !== "game" || !isHongKongTitleUrl(candidate.productUrl)) continue;
    roots.set(candidate.productUrl, candidate);
  }
  return [...roots.values()].sort(compareOfficialCandidates);
}

/** 关系根必须是无查询参数和片段的港区 titles 数字资源；普通官网、bundles 与 aocs 即使是官方链接也不能展开。 */
function isHongKongTitleUrl(productUrl: string): boolean {
  try {
    const url = new URL(productUrl);
    return url.protocol === "https:"
      && url.hostname === "ec.nintendo.com"
      && /^\/HK\/zh\/titles\/\d+$/.test(url.pathname)
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
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
/**
 * 比较两个任天堂官方候选的严格身份。该规则只适合标题未本地化的场景；发行商缺失时不把缺失误判为冲突，
 * 但调用方仍须先确认 URL、地区和类型来自本区官方搜索，不能把这个纯文本比较当作链接验证器。
 */
export function hasSameOfficialIdentity(left: OfficialProductCandidate, right: OfficialProductCandidate): boolean {
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
 * 判断日区首轮结果能否作为受限的本地化检索锚点。它允许商品类型不同，因为官方可能只先返回本体，
 * 但要求官方日区 URL、双方明确相同的发行商和拉丁系列标记；缺一项都不能从标题中抽取日文词继续检索。
 */
function isJapaneseSeriesSearchAnchor(anchor: OfficialProductCandidate, option: OfficialProductCandidate): boolean {
  return option.regionCode === "JP"
    && isOfficialNintendoProductUrl("JP", option.productUrl)
    && anchor.publisher !== null
    && option.publisher !== null
    && normalizeTitle(anchor.publisher) === normalizeTitle(option.publisher)
    && latinTitleMarker(anchor.canonicalTitle) !== null
    && latinTitleMarker(anchor.canonicalTitle) === latinTitleMarker(option.canonicalTitle);
}

/**
 * 从已验证日区标题提取一段包含片假名和可选编号的系列别名，并统一全角数字。该函数不翻译英文也不猜测词典，
 * 以免未知游戏或营销文案触发宽泛日文搜索；没有唯一片假名片段时调用方必须回退到管理员手动链接。
 */
function readJapaneseSeriesAlias(title: string): string | null {
  const aliases = [...new Set(title.normalize("NFKC").match(/[\p{Script=Katakana}ー]+(?:\s*\d+)?/gu) ?? [])]
    .map((alias) => alias.replace(/\s+/g, ""))
    .filter((alias) => /\p{Script=Katakana}/u.test(alias));
  return aliases.length === 1 ? aliases[0] : null;
}

/**
 * 仅判断两条已验证官方候选是否拥有完整的本地化自动身份信号。返回 true 不代表可自动写入：
 * 调用方还必须在同一次本区官方搜索结果中确认该候选唯一，防止两个同名版本按结果顺序被任选一个。
 */
export function hasHighConfidenceLocalizedIdentity(anchor: OfficialProductCandidate, option: OfficialProductCandidate): boolean {
  return localizedIdentityRelevance(anchor, option) === 2;
}

/**
 * 在一批同区官方搜索候选中重新证明自动匹配唯一。最终订阅确认不能信任浏览器提交的 `automatic` 字符串，
 * 因而必须以当次官方结果重新计算严格或本地化身份，并要求目标 URL 是唯一匹配项。
 */
export function isUniqueAutomaticRegionalCandidate(
  anchor: OfficialProductCandidate,
  candidate: OfficialProductCandidate,
  regionalCandidates: OfficialProductCandidate[],
): boolean {
  const automaticMatches = regionalCandidates.filter((option) => option.regionCode === candidate.regionCode
    && option.productType === anchor.productType
    && isOfficialNintendoProductUrl(candidate.regionCode, option.productUrl)
    && (hasSameOfficialIdentity(anchor, option) || hasHighConfidenceLocalizedIdentity(anchor, option)));
  return automaticMatches.length === 1 && automaticMatches[0].productUrl === candidate.productUrl;
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
 * 版本标记是本地化自动确认的第二项独立信号。仅接受已在规格和官方页面中验证过的 Switch 2 Edition
 * 与美食家版中日标记；这不是翻译器，未识别的新版本命名必须降级为人工确认，而不是猜测其等价关系。
 */
function editionMarker(title: string): string | null {
  const normalized = title.normalize("NFKC");
  if (/nintendo\s+switch\s*2\s+edition/iu.test(normalized)) return "nintendo-switch-2-edition";
  if (/gourmet\s+edition|真の食通エディション/iu.test(normalized)) return "gourmet-edition";
  return null;
}

/** 规范化只用于瞬时自动匹配，不覆盖或修改管理员最终确认的官方标题。 */
function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
