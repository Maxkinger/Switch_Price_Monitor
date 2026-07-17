import type { ConfirmedRegionalProduct, OfficialProductCandidate, RegionCode } from "../../shared/domain";
import type { OfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import {
  SubscriptionConfirmationRepository,
  type ValidatedConfirmedRegion,
} from "../repositories/subscription-confirmation-repository";
import type { OfficialPriceIdResolution, OfficialPriceIdService } from "./official-price-id-service";
import type { RegionResolution, OfficialProductDiscoveryService } from "./official-product-discovery-service";
import type { EnabledRegionSettingsReader } from "./subscription-confirmation-service";

/** 补全服务只依赖官方价格 ID 的解析方法，避免把网络适配器、秘密或不相关的采集能力传入业务边界。 */
type OfficialPriceIdResolver = Pick<OfficialPriceIdService, "resolve">;

/** 复用发现服务的安全跨区解析入口；地区范围仍由服务端设置决定，浏览器不能提供地区数组。 */
type ConfiguredRegionResolver = Pick<OfficialProductDiscoveryService, "resolveRegions">;

/** 订阅不存在时专用错误供路由稳定映射为 404，不泄露 D1 查询或官方页面解析细节。 */
export class SubscriptionRegionCompletionNotFoundError extends Error {}

/** 可预期的官方身份、地区覆盖或请求错误；路由只返回安全中文摘要和 422。 */
export class SubscriptionRegionCompletionError extends Error {}

/** 浏览器提交的补全载荷不含游戏 ID 或锚点 URL；这两项必须从当前订阅的 D1 记录读取。 */
export interface CompletionRegionsInput {
  regions: ConfirmedRegionalProduct[];
  skippedRegionCodes: RegionCode[];
}

/** 成功结果只暴露订阅与新增地区代码，避免将 D1 主键、官方响应正文或既有商品 URL 返回浏览器。 */
export interface CompletionRegionsResult {
  subscriptionId: string;
  addedRegionCodes: RegionCode[];
}

/**
 * 已有订阅地区补全把“读取既有锚点、重验任天堂页面、校验设置覆盖范围、原子追加”放在同一服务。
 * 它绝不删除或替换既有地区、价格快照、目标价、启用状态和订阅 ID，补全失败也不会产生部分写入。
 */
export class SubscriptionRegionCompletionService {
  public constructor(
    private readonly repository: SubscriptionConfirmationRepository,
    private readonly pages: OfficialNintendoProductPageResolver,
    private readonly officialPriceIds: OfficialPriceIdResolver,
    private readonly settings: EnabledRegionSettingsReader,
    private readonly discovery: ConfiguredRegionResolver,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * 从当前订阅的既有地区商品重验官方锚点，再仅返回设置中尚未监控的地区解析结果。
   * 即便数据库里已有旧链接，也不会把它直接当事实；任天堂公开页无法验证时保持人工修复边界而不猜测身份。
   */
  public async resolveExisting(subscriptionId: string): Promise<RegionResolution[]> {
    const existing = await this.requireExisting(subscriptionId);
    const anchor = await this.resolveOfficialCandidate(existing.anchor);
    const resolutions = await this.discovery.resolveRegions([anchor]);
    return resolutions.filter((resolution) => !existing.existingRegionCodes.includes(resolution.regionCode));
  }

  /**
   * 再次读取订阅和保存设置后验证本次补全。所有目标启用地区必须已存在、经官方确认或被明确跳过；
   * 验证完成前不调用仓储写入，因此错误的链接、跨游戏候选或旧缓存请求均不会改变已有监控历史。
   */
  public async completeExisting(subscriptionId: string, input: CompletionRegionsInput, now: string): Promise<CompletionRegionsResult> {
    if (!Array.isArray(input.regions) || !Array.isArray(input.skippedRegionCodes)) {
      throw new SubscriptionRegionCompletionError("补全地区设置无效。");
    }
    const [existing, settings] = await Promise.all([this.requireExisting(subscriptionId), this.settings.get()]);
    if (!settings) throw new SubscriptionRegionCompletionError("应用尚未完成初始化。");
    const anchor = await this.resolveOfficialCandidate(existing.anchor);
    const validated = await Promise.all(input.regions.map((region) => this.validateRegion(region, anchor)));
    this.validateCoverage(settings.enabledRegions, existing.existingRegionCodes, validated, input.skippedRegionCodes);
    const additions = validated.map((region) => ({ id: this.createId(), ...region }));
    await this.repository.completeAtomically(existing.subscriptionId, existing.gameId, additions, now);
    return { subscriptionId: existing.subscriptionId, addedRegionCodes: additions.map((region) => region.regionCode) };
  }

  /** 从仓储读取失败时不继续访问任天堂，避免无效订阅 ID 触发外部请求或暴露任何存在性细节。 */
  private async requireExisting(subscriptionId: string) {
    const existing = await this.repository.findForRegionCompletion(subscriptionId);
    if (!existing) throw new SubscriptionRegionCompletionNotFoundError("订阅不存在。");
    return existing;
  }

  /** 重新解析任天堂官方链接；浏览器或历史数据库记录的标题、价格与发行商都不能跳过这层身份验证。 */
  private async resolveOfficialCandidate(candidate: OfficialProductCandidate): Promise<OfficialProductCandidate> {
    const verified = await this.pages.resolve(candidate.regionCode, candidate.productUrl, new AbortController().signal);
    if (!verified) throw new SubscriptionRegionCompletionError("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");
    return verified;
  }

  /** 单区新增候选必须来自受控来源、与重验锚点具有同一逻辑身份，并通过本区官方价格 ID 二次验证。 */
  private async validateRegion(region: ConfirmedRegionalProduct, anchor: OfficialProductCandidate): Promise<Omit<ValidatedConfirmedRegion, "id">> {
    if (!isMatchSource(region.matchSource)) throw new SubscriptionRegionCompletionError("地区商品匹配来源无效。");
    const verified = await this.resolveOfficialCandidate(region);
    if (!hasSameLogicalIdentity(anchor, verified)) throw new SubscriptionRegionCompletionError("地区商品与既有订阅身份不一致。");
    const officialPrice = await this.officialPriceIds.resolve(verified);
    return {
      regionCode: verified.regionCode,
      currency: verified.currency,
      officialPriceId: officialPriceIdOrNull(officialPrice),
      productUrl: verified.productUrl,
      matchSource: region.matchSource,
    };
  }

  /**
   * 设置是补全地区范围的唯一事实来源。已有地区保留为已确认，新候选和跳过只允许覆盖当前启用且尚未存在的地区；
   * 这样设置缩小不会删除历史，而设置扩展后也不能让浏览器静默遗漏新地区。
   */
  private validateCoverage(enabledRegions: RegionCode[], existingRegionCodes: RegionCode[], regions: Array<Omit<ValidatedConfirmedRegion, "id">>, skippedRegionCodes: RegionCode[]): void {
    const newCodes = regions.map((region) => region.regionCode);
    const existing = new Set(existingRegionCodes);
    if (new Set(newCodes).size !== newCodes.length || newCodes.some((regionCode) => existing.has(regionCode))) {
      throw new SubscriptionRegionCompletionError("补全地区不能重复或覆盖既有地区。");
    }
    if (new Set(skippedRegionCodes).size !== skippedRegionCodes.length || skippedRegionCodes.some((regionCode) => existing.has(regionCode))) {
      throw new SubscriptionRegionCompletionError("跳过地区设置无效。");
    }
    if (newCodes.some((regionCode) => !enabledRegions.includes(regionCode)) || skippedRegionCodes.some((regionCode) => !enabledRegions.includes(regionCode))) {
      throw new SubscriptionRegionCompletionError("地区不在当前启用范围内。");
    }
    const covered = new Set([...existingRegionCodes, ...newCodes, ...skippedRegionCodes]);
    if (newCodes.some((regionCode) => skippedRegionCodes.includes(regionCode)) || enabledRegions.some((regionCode) => !covered.has(regionCode))) {
      throw new SubscriptionRegionCompletionError("请确认或跳过所有已启用地区。");
    }
  }
}

/** 匹配来源只接受三种已确认枚举；运行时校验阻止绕过 TypeScript 的 HTTP 请求写入未知审计值。 */
function isMatchSource(value: unknown): value is ConfirmedRegionalProduct["matchSource"] {
  return value === "automatic" || value === "manual_selection" || value === "manual_link";
}

/** 身份比较只使用规范化标题、受控商品类型和双方存在时的发行商，价格与语言差异不能单独决定同一性。 */
function hasSameLogicalIdentity(left: OfficialProductCandidate, right: OfficialProductCandidate): boolean {
  if (normalize(left.canonicalTitle) !== normalize(right.canonicalTitle) || left.productType !== right.productType) return false;
  return left.publisher === null || right.publisher === null || normalize(left.publisher) === normalize(right.publisher);
}

/** 规范化仅用于身份比较，不改写数据库展示名称或任天堂官方页面标题。 */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** 仅持久化由官方价格 ID 服务确认的本区 ID；其他地区明确保存 null，禁止跨区挪用。 */
function officialPriceIdOrNull(resolution: OfficialPriceIdResolution): string | null {
  return resolution.status === "official-available" ? resolution.officialPriceId : null;
}
