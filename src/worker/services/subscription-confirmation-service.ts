import type {
  ConfirmedRegionalProduct,
  ConfirmedSubscriptionInput,
  OfficialProductCandidate,
  RegionalProductMatchSource,
  RegionCode,
  SubscriptionConfirmationResult,
} from "../../shared/domain";
import type { OfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import {
  SubscriptionConfirmationRepository,
  type ValidatedConfirmedRegion,
  type ValidatedSubscriptionConfirmation,
} from "../repositories/subscription-confirmation-repository";
import type { OfficialPriceIdResolution, OfficialPriceIdService } from "./official-price-id-service";
import {
  hasHighConfidenceLocalizedIdentity,
  hasSameOfficialIdentity,
} from "./official-product-discovery-service";
import type { JapaneseSubscriptionConfirmationService } from "./japanese-subscription-confirmation-service";

/** 服务仅需要官方价格 ID 的只读解析能力，窄接口使测试不必创建真实官方网络适配器。 */
type OfficialPriceIdResolver = Pick<OfficialPriceIdService, "resolve">;

/** 日区双官方接口确认器的窄依赖；最终订阅服务不应了解搜索或价格 API 的 URL、字段和超时细节。 */
type JapaneseCandidateResolver = Pick<JapaneseSubscriptionConfirmationService, "resolve">;

/**
 * 非日区 automatic 候选的最终唯一性验证窄接口。实现由官方发现服务提供；确认服务只关心相同 URL 是否仍可自动成立，
 * 不接触搜索词、关联结构或地区适配器细节。
 */
export interface AutomaticRegionalCandidateVerifier {
  verifyAutomaticRegionalCandidate(anchor: OfficialProductCandidate, candidate: OfficialProductCandidate): Promise<boolean>;
}

/** 未注入发现服务时 automatic 一律安全拒绝；生产入口会显式注入真实实现，人工选择与日区专用确认不受影响。 */
const unavailableAutomaticRegionalCandidateVerifier: AutomaticRegionalCandidateVerifier = {
  verifyAutomaticRegionalCandidate: async () => false,
};

/**
 * 最终确认只读取启用地区，不读取默认搜索区或展示偏好。确认时重新读取设置，
 * 才能阻止浏览器旧缓存将未处理地区静默遗漏或伪造额外地区映射。
 */
export interface EnabledRegionSettingsReader {
  get(): Promise<{ enabledRegions: RegionCode[] } | null>;
}

/** 最终确认的可预期表单/官方身份错误；路由会将其安全映射为 422，不暴露外部页面或 D1 细节。 */
export class SubscriptionConfirmationError extends Error {}

/**
 * 最终确认服务是“瞬时发现 DTO”到“可采集订阅记录”的唯一业务闸门。除日区使用搜索与价格双官方接口外，
 * 它重读本区官方商品页，以重新验证的标题、币种、类型、发行商和价格 ID 生成写入数据，
 * 绝不把浏览器自报的候选身份直接持久化。
 */
export class SubscriptionConfirmationService {
  public constructor(
    private readonly repository: SubscriptionConfirmationRepository,
    private readonly pages: OfficialNintendoProductPageResolver,
    private readonly officialPriceIds: OfficialPriceIdResolver,
    private readonly settings: EnabledRegionSettingsReader,
    private readonly japanese: JapaneseCandidateResolver,
    private readonly automaticVerifier: AutomaticRegionalCandidateVerifier = unavailableAutomaticRegionalCandidateVerifier,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * 先完成整批每项的官方重验证与逻辑游戏去重，再查询既有订阅，最后只把真正新建项交给一个 D1 批次。
   * 因此任一候选无效、同批重复或官方验证失败都会发生在写入之前，已存在的订阅也不会被隐式覆盖。
   */
  public async confirm(inputs: ConfirmedSubscriptionInput[], now: string): Promise<SubscriptionConfirmationResult[]> {
    if (inputs.length === 0) throw new SubscriptionConfirmationError("请至少确认一个商品订阅。");
    const validated = await Promise.all(inputs.map((input) => this.validate(input)));
    const normalizedNames = validated.map((input) => input.game.normalizedName);
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      throw new SubscriptionConfirmationError("同一批次不能重复确认同一游戏。");
    }

    const existing = await this.repository.findExistingByNormalizedNames(normalizedNames);
    const creations = validated
      .filter((input) => !existing.has(input.game.normalizedName))
      .map((input) => this.withServerGeneratedIds(input));
    await this.repository.createAtomically(creations, now);

    return validated.map((input) => {
      const previous = existing.get(input.game.normalizedName);
      // 仓储携带 normalizedName 仅用于 Map 查找；对外结果严格投影为游戏与订阅 ID，避免内部去重键泄漏到 API。
      if (previous) return { gameId: previous.gameId, subscriptionId: previous.subscriptionId, status: "existing" as const };
      return {
        gameId: creations.find((creation) => creation.game.normalizedName === input.game.normalizedName)?.game.id ?? "",
        subscriptionId: creations.find((creation) => creation.game.normalizedName === input.game.normalizedName)?.subscriptionId ?? "",
        status: "created" as const,
      };
    });
  }

  /**
   * 验证一个逻辑游戏的所有地区映射。默认区候选必须恰好出现在地区列表一次，且所有已验证地区都要与默认区身份相同；
   * 重新读取的启用地区必须被确认或显式跳过，否则同名 DLC、本体或升级包可能被混入或被静默遗漏。
   */
  private async validate(input: ConfirmedSubscriptionInput): Promise<UnidentifiedValidatedSubscription> {
    if (!Array.isArray(input.regions) || input.regions.length === 0) throw new SubscriptionConfirmationError("每个游戏至少确认一个地区商品。");
    if (!Array.isArray(input.skippedRegionCodes)) throw new SubscriptionConfirmationError("跳过地区设置无效。");
    const settings = await this.settings.get();
    if (!settings) throw new SubscriptionConfirmationError("应用尚未完成初始化。");
    // 默认区是整项订阅的可信锚点，日区作为默认区时也必须经过其专用双 API 复核，而不能保留浏览器的候选字段。
    const selected = await this.resolveOfficialCandidate(input.selected, input.selected, "manual_selection");
    const regions = await Promise.all(input.regions.map((region) => this.validateRegion(region, selected)));
    if (new Set(regions.map((region) => region.regionCode)).size !== regions.length) {
      throw new SubscriptionConfirmationError("每个游戏在每区只能确认一个商品。");
    }
    const selectedRegions = regions.filter((region) => region.regionCode === selected.regionCode && region.productUrl === selected.productUrl);
    if (selectedRegions.length !== 1) throw new SubscriptionConfirmationError("默认区商品必须在确认地区中保留一次。");
    this.validateConfiguredRegionCoverage(settings.enabledRegions, selected.regionCode, regions, input.skippedRegionCodes);

    return {
      game: {
        // 官方页面通常不含可验证中文译名；首版将官方标题同时存为中英文回退显示，后续可在管理员编辑中补充中文名。
        nameZh: selected.canonicalTitle,
        nameEn: selected.canonicalTitle,
        normalizedName: normalizedGameName(selected),
        publisher: selected.publisher,
        productType: selected.productType,
        coverUrl: selected.coverUrl,
      },
      regions,
    };
  }

  /**
   * 设置覆盖校验同时在服务层执行，不能只依赖页面禁用按钮。确认与跳过必须互斥且都属于当前启用地区，
   * 这样设置变更、旧缓存或手工 API 请求均无法创建未说明原因的默认区单区订阅。
   */
  private validateConfiguredRegionCoverage(
    enabledRegions: RegionCode[],
    defaultRegion: RegionCode,
    regions: UnidentifiedValidatedRegion[],
    skippedRegionCodes: RegionCode[],
  ): void {
    const confirmedCodes = regions.map((region) => region.regionCode);
    if (new Set(skippedRegionCodes).size !== skippedRegionCodes.length || skippedRegionCodes.includes(defaultRegion)) {
      throw new SubscriptionConfirmationError("跳过地区设置无效。");
    }
    if (confirmedCodes.some((regionCode) => !enabledRegions.includes(regionCode)) || skippedRegionCodes.some((regionCode) => !enabledRegions.includes(regionCode))) {
      throw new SubscriptionConfirmationError("地区不在当前启用范围内。");
    }
    const covered = new Set([...confirmedCodes, ...skippedRegionCodes]);
    if (confirmedCodes.some((regionCode) => skippedRegionCodes.includes(regionCode)) || enabledRegions.some((regionCode) => !covered.has(regionCode))) {
      throw new SubscriptionConfirmationError("请确认或跳过所有已启用地区。");
    }
  }

  /**
   * 重新确认官方候选并只采用服务器取得的字段。日区商品页可能返回 JavaScript 排队或动态外壳，
   * 因而只对 JP 使用官方搜索 + 官方价格 API；其它地区继续经页面解析器复核，浏览器价格、封面和发行商始终被忽略。
   */
  private async resolveOfficialCandidate(
    anchor: OfficialProductCandidate,
    candidate: OfficialProductCandidate,
    matchSource: RegionalProductMatchSource,
  ): Promise<OfficialProductCandidate> {
    if (candidate.regionCode === "JP") {
      const verifiedJapanese = await this.japanese.resolve(anchor, candidate, matchSource);
      if (!verifiedJapanese) throw new SubscriptionConfirmationError("日区官方商品确认暂时失败，请重新核验其他地区后再试。");
      return verifiedJapanese;
    }
    const verified = await this.pages.resolve(candidate.regionCode, candidate.productUrl, new AbortController().signal);
    if (!verified) throw new SubscriptionConfirmationError("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");
    return verified;
  }

  /**
   * 单区候选需通过官方重读、按来源分级的身份比较与本区价格 ID 二次验证后才可进入 D1 批次。
   * 浏览器提供的 `matchSource` 只表达管理员/系统的审计路径，不能替代官方 URL 重验，也不能影响最终写入的官方字段。
   */
  private async validateRegion(region: ConfirmedRegionalProduct, selected: OfficialProductCandidate): Promise<UnidentifiedValidatedRegion> {
    if (!isMatchSource(region.matchSource)) throw new SubscriptionConfirmationError("地区商品匹配来源无效。");
    const verified = await this.resolveOfficialCandidate(selected, region, region.matchSource);
    if (!hasConfirmedRegionIdentity(selected, verified, region.matchSource)) throw new SubscriptionConfirmationError("地区商品与默认区商品身份不一致。");
    if (region.matchSource === "automatic" && verified.regionCode !== "JP") {
      // 非日区详情相同只证明商品本身存在，不能证明它仍是跨区唯一候选；写入前必须复跑官方发现规则并绑定同一 URL。
      const remainsAutomatic = await this.automaticVerifier.verifyAutomaticRegionalCandidate(selected, verified);
      if (!remainsAutomatic) throw new SubscriptionConfirmationError("地区商品自动匹配已失效，请重新核验其他地区。");
    }
    const officialPrice = await this.officialPriceIds.resolve(verified);
    return {
      regionCode: verified.regionCode,
      currency: verified.currency,
      officialPriceId: officialPriceIdOrNull(officialPrice),
      productUrl: verified.productUrl,
      matchSource: region.matchSource,
    };
  }

  /** 服务端生成所有业务主键，令浏览器无法通过重复或猜测 ID 影响既有游戏、地区商品与订阅。 */
  private withServerGeneratedIds(input: UnidentifiedValidatedSubscription): ValidatedSubscriptionConfirmation {
    return {
      game: { id: this.createId(), ...input.game },
      subscriptionId: this.createId(),
      regions: input.regions.map((region) => ({ id: this.createId(), ...region })),
    };
  }
}

/** 写入前内部模型没有服务端 ID，确保只有通过全量验证且确属新建的游戏才分配可持久化主键。 */
interface UnidentifiedValidatedSubscription {
  game: Omit<ValidatedSubscriptionConfirmation["game"], "id">;
  regions: UnidentifiedValidatedRegion[];
}

/** 单区内部模型同样不含 ID，避免在验证失败或命中既有订阅时浪费/暴露任何可持久化标识。 */
type UnidentifiedValidatedRegion = Omit<ValidatedConfirmedRegion, "id">;

/** 匹配来源只接受产品已确认的三种值，服务层仍做运行时验证以防直接 API 或未来调用方绕开 TypeScript。 */
function isMatchSource(value: unknown): value is RegionalProductMatchSource {
  return value === "automatic" || value === "manual_selection" || value === "manual_link";
}

/**
 * 按来源决定最终确认的身份强度。`automatic` 没有管理员逐项选择，必须保持严格身份，
 * 或使用发现与日区复核都已验证的高置信度本地化身份；后者不依据翻译或模糊语义。
 * `manual_selection`/`manual_link` 则允许地区语言和发行商写法不同，但在 Worker 已重验本区官方 URL 的前提下，
 * 仍必须是与默认区相同的受控商品类型。这样不会把人工确认误扩展为任意链接或本体/DLC/升级包之间的混配。
 */
function hasConfirmedRegionIdentity(
  anchor: OfficialProductCandidate,
  verified: OfficialProductCandidate,
  matchSource: RegionalProductMatchSource,
): boolean {
  return matchSource === "automatic"
    ? hasSameOfficialIdentity(anchor, verified) || hasHighConfidenceLocalizedIdentity(anchor, verified)
    : anchor.productType === verified.productType;
}

/** 规范化身份保留标题、可空发行商和类型，避免仅按名称把同名 DLC、本体或不同发行商商品合并。 */
export function normalizedGameName(candidate: Pick<OfficialProductCandidate, "canonicalTitle" | "publisher" | "productType">): string {
  return [normalize(candidate.canonicalTitle), candidate.publisher === null ? "" : normalize(candidate.publisher), candidate.productType].join("|");
}

/** 只用于身份比较与去重，不修改官方展示标题；Unicode 小写规则使不同语言标题的规范化行为稳定可预期。 */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** 仅把重新验证成功的本区官方 ID 写入地区商品；其他地区明确保存 null，不能跨区复用 ID。 */
function officialPriceIdOrNull(resolution: OfficialPriceIdResolution): string | null {
  return resolution.status === "official-available" ? resolution.officialPriceId : null;
}
