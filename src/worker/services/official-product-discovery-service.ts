import type { OfficialProductCandidate, OfficialProductSearch, OfficialSearchResult, RegionCode } from "../../shared/domain";
import type { OfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";

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
  | { candidateKey: string; regionCode: RegionCode; status: "needs-manual-selection"; candidates: OfficialProductCandidate[] }
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

  /** 为一个游戏/地区组合选择安全的自动候选或人工确认状态，绝不按数组位置把候选分配给其他游戏。 */
  private async matchRegion(candidate: OfficialProductCandidate, regionCode: RegionCode): Promise<RegionResolution> {
    const candidateKey = officialCandidateKey(candidate);
    const result = await this.search.search(regionCode, candidate.canonicalTitle, new AbortController().signal);
    if (result.status === "unavailable") return { candidateKey, regionCode, status: "needs-manual-link" };

    const matches = result.candidates.filter((option) => hasSameOfficialIdentity(candidate, option));
    if (matches.length === 1) return { candidateKey, regionCode, status: "automatic", candidate: matches[0] };
    return matches.length > 1
      ? { candidateKey, regionCode, status: "needs-manual-selection", candidates: matches }
      : { candidateKey, regionCode, status: "needs-manual-link" };
  }
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

/** 规范化只用于瞬时自动匹配，不覆盖或修改管理员最终确认的官方标题。 */
function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
