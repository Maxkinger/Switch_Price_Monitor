import type {
  ConfirmedRegionalProduct,
  ConfirmedSubscriptionInput,
  OfficialProductCandidate,
  RegionalProductMatchSource,
  RegionCode,
  SubscriptionConfirmationResult,
} from "../shared/domain";
import { gameNameIdentityKey } from "../shared/game-name-identity";
import type { OfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import {
  type ValidatedConfirmedRegion,
  type ValidatedSubscriptionConfirmation,
  type SubscriptionConfirmationStore,
} from "../repositories/ports";
import type { OfficialPriceIdResolution, OfficialPriceIdService } from "./official-price-id-service";
import {
  GameNameValidationError,
  type GameNameService,
  type ResolvedGameDisplayName,
} from "./game-name-service";
import {
  hasHighConfidenceLocalizedIdentity,
  hasSameOfficialIdentity,
} from "./official-product-discovery-service";
import type { JapaneseSubscriptionConfirmationService } from "./japanese-subscription-confirmation-service";
import {
  japaneseUpgradeConfirmationKey,
  type JapaneseUpgradeConfirmationItem,
  type JapaneseUpgradeConfirmationResult,
  type JapaneseUpgradeRelationService,
} from "./japanese-upgrade-relation-service";

/** 服务仅需要官方价格 ID 的只读解析能力，窄接口使测试不必创建真实官方网络适配器。 */
type OfficialPriceIdResolver = Pick<OfficialPriceIdService, "resolve">;

/** 日区双官方接口确认器的窄依赖；最终订阅服务不应了解搜索或价格 API 的 URL、字段和超时细节。 */
type JapaneseCandidateResolver = Pick<JapaneseSubscriptionConfirmationService, "resolve">;

/** 日区升级关系服务的保存前窄接口；确认服务只消费整批结论，不接触 Browser、根搜索或报价请求细节。 */
type JapaneseUpgradeVerifier = Pick<JapaneseUpgradeRelationService, "verifyForConfirmation">;

/** 名称服务的保存前窄接口；确认流程只请求精确身份的最终展示决议，不获得词条管理或历史回填能力。 */
type ConfirmedGameNameResolver = Pick<GameNameService, "resolveForConfirmedGame">;

/** 本次确认请求的升级证据仅存于内存 Map，键同时包含锚点、日区 URL 与来源，不能跨商品或跨请求复用。 */
type JapaneseUpgradeVerificationMap = Map<string, JapaneseUpgradeConfirmationResult>;

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

/** 最终确认的可预期表单/官方身份错误；路由会将其安全映射为 422，不暴露外部页面或数据库细节。 */
export class SubscriptionConfirmationError extends Error {}

/**
 * 最终确认服务是“瞬时发现 DTO”到“可采集订阅记录”的唯一业务闸门。普通日区商品使用搜索与价格双官方接口，
 * 日区升级包使用根商品、Browser 关系与官方报价整批复核，其它地区重读本区官方商品页；所有路径都只以重新验证的
 * 标题、币种、类型、发行商和价格 ID 生成写入数据，绝不把浏览器自报的候选身份直接持久化。
 */
export class SubscriptionConfirmationService {
  public constructor(
    private readonly repository: SubscriptionConfirmationStore,
    private readonly pages: OfficialNintendoProductPageResolver,
    private readonly officialPriceIds: OfficialPriceIdResolver,
    private readonly settings: EnabledRegionSettingsReader,
    private readonly japanese: JapaneseCandidateResolver,
    private readonly japaneseUpgrades: JapaneseUpgradeVerifier,
    private readonly gameNames: ConfirmedGameNameResolver,
    private readonly automaticVerifier: AutomaticRegionalCandidateVerifier = unavailableAutomaticRegionalCandidateVerifier,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * 先完成整批每项的官方重验证与逻辑游戏去重，再查询既有订阅，最后只把真正新建项交给一个原子仓储事务。
   * 因此任一候选无效、同批重复或官方验证失败都会发生在写入之前，已存在的订阅也不会被隐式覆盖。
   */
  public async confirm(inputs: ConfirmedSubscriptionInput[], now: string): Promise<SubscriptionConfirmationResult[]> {
    if (inputs.length === 0) throw new SubscriptionConfirmationError("请至少确认一个商品订阅。");
    // 关系根搜索会使用锚点标题与发行商，故非日区升级包必须先从官方来源重建；JP 默认升级包暂时只作为关系 Map 的查找锚点，不能进入最终游戏身份。
    const relationshipAnchors = await Promise.all(inputs.map((input) => this.resolveAnchorBeforeUpgradeVerification(input.selected)));
    // 日区升级关系仍先于设置仓储与既有订阅查询整批复核；超过三项或任一外部失败都不能让数据库进入部分确认流程。
    const upgradeItems = collectJapaneseUpgradeConfirmationItems(inputs, relationshipAnchors);
    const verifiedUpgrades = await this.japaneseUpgrades.verifyForConfirmation(upgradeItems);
    // JP 默认升级包必须在关系批处理签发后替换浏览器锚点；其它路径已经由上一步官方重建，保持同一候选即可。
    const verifiedAnchors = inputs.map((input, index) => this.resolveAnchorAfterUpgradeVerification(
      input,
      relationshipAnchors[index],
      verifiedUpgrades,
    ));
    const validated = await Promise.all(inputs.map((input, index) => this.validate(
      input,
      verifiedAnchors[index],
      relationshipAnchors[index],
      verifiedUpgrades,
    )));
    const normalizedNames = validated.map((input) => input.game.normalizedName);
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      throw new SubscriptionConfirmationError("同一批次不能重复确认同一游戏。");
    }

    const existing = await this.repository.findExistingByNormalizedNames(normalizedNames);
    const creations = validated
      .filter((input) => !existing.has(input.game.normalizedName))
      .map((input) => this.withServerGeneratedIds(input));
    await this.repository.createAtomically(creations, now);

    return this.projectConfirmationResults(validated, existing, creations);
  }

  /**
   * 在 Browser 关系请求前取得不可由浏览器篡改的默认区身份。非日区使用官方商品页，普通日区继续使用双官方 API；
   * 日区升级包本身没有可独立证明关系的普通解析路径，只能留给随后同批关系验证并按来源安全拒绝或签发。
   */
  private async resolveAnchorBeforeUpgradeVerification(candidate: OfficialProductCandidate): Promise<OfficialProductCandidate> {
    if (candidate.regionCode === "JP" && candidate.productType === "upgrade-pack") return candidate;
    return this.resolveOfficialCandidate(candidate, candidate, "manual_selection", new Map());
  }

  /**
   * JP 默认区升级包没有可在 Browser 关系核验前独立重建的普通解析路径，因此必须从本批关系服务的精确签发结果取得最终锚点。
   * 查找键仍使用关系服务实际接收的预验证锚点与默认区地区项；签发 candidate 才能进入名称目录、去重键和游戏持久化。
   */
  private resolveAnchorAfterUpgradeVerification(
    input: ConfirmedSubscriptionInput,
    relationshipAnchor: OfficialProductCandidate,
    verifiedUpgrades: JapaneseUpgradeVerificationMap,
  ): OfficialProductCandidate {
    if (relationshipAnchor.regionCode !== "JP" || relationshipAnchor.productType !== "upgrade-pack") {
      return relationshipAnchor;
    }
    const selectedRegion = input.regions.find((region) => (
      region.regionCode === relationshipAnchor.regionCode
      && region.productUrl === relationshipAnchor.productUrl
      && region.productType === "upgrade-pack"
    ));
    if (selectedRegion === undefined) throw new SubscriptionConfirmationError("默认区商品必须在确认地区中保留一次。");
    return this.readVerifiedJapaneseUpgrade({
      anchor: relationshipAnchor,
      candidate: selectedRegion,
      matchSource: selectedRegion.matchSource,
    }, verifiedUpgrades);
  }

  /**
   * 将幂等查询与新建批次投影为稳定 API 结果。该函数不访问数据库、不生成 ID，
   * 只使用已经完成原子写入的内存模型，避免结果装配再次触碰持久化边界。
   */
  private projectConfirmationResults(
    validated: UnidentifiedValidatedSubscription[],
    existing: Awaited<ReturnType<SubscriptionConfirmationStore["findExistingByNormalizedNames"]>>,
    creations: ValidatedSubscriptionConfirmation[],
  ): SubscriptionConfirmationResult[] {
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
  private async validate(
    input: ConfirmedSubscriptionInput,
    selected: OfficialProductCandidate,
    relationshipAnchor: OfficialProductCandidate,
    verifiedUpgrades: JapaneseUpgradeVerificationMap,
  ): Promise<UnidentifiedValidatedSubscription> {
    if (!Array.isArray(input.regions) || input.regions.length === 0) throw new SubscriptionConfirmationError("每个游戏至少确认一个地区商品。");
    if (!Array.isArray(input.skippedRegionCodes)) throw new SubscriptionConfirmationError("跳过地区设置无效。");
    const settings = await this.settings.get();
    if (!settings) throw new SubscriptionConfirmationError("应用尚未完成初始化。");
    // selected 始终是最终官方候选；relationshipAnchor 仅保留关系 Map 原始键，绝不能参与后续游戏身份、名称目录或持久化字段。
    const regions = await Promise.all(input.regions.map((region) => this.validateRegion(
      region,
      selected,
      relationshipAnchor,
      verifiedUpgrades,
    )));
    if (new Set(regions.map((region) => region.regionCode)).size !== regions.length) {
      throw new SubscriptionConfirmationError("每个游戏在每区只能确认一个商品。");
    }
    const selectedRegions = regions.filter((region) => region.regionCode === selected.regionCode && region.productUrl === selected.productUrl);
    if (selectedRegions.length !== 1) throw new SubscriptionConfirmationError("默认区商品必须在确认地区中保留一次。");
    this.validateConfiguredRegionCoverage(settings.enabledRegions, selected.regionCode, regions, input.skippedRegionCodes);

    // identityKey 只取服务器刚重验的官方锚点；浏览器提交的 selected 文本和中文候选均不得参与词条查找或既有订阅去重。
    const normalizedName = gameNameIdentityKey(selected);
    let resolvedName: ResolvedGameDisplayName;
    try {
      resolvedName = await this.gameNames.resolveForConfirmedGame(normalizedName, input.displayNameZhCn ?? null);
    } catch (error) {
      // 只把名称服务明确标记的表单边界转换为 422 领域错误；数据库或词条仓储故障不得伪装成可重试的管理员输入问题。
      if (error instanceof GameNameValidationError) throw new SubscriptionConfirmationError(error.message);
      throw error;
    }
    if (resolvedName.displayNameZhCn === null || resolvedName.source === "pending") {
      throw new SubscriptionConfirmationError("请确认简体中文游戏名称。");
    }

    return {
      game: {
        // legacy nameZh 同步保存最终名称只为兼容旧消费者；新读取 DTO 必须直接投影 displayNameZhCn，不能回退推断旧列。
        nameZh: resolvedName.displayNameZhCn,
        displayNameZhCn: resolvedName.displayNameZhCn,
        displayNameSource: resolvedName.source,
        nameEn: selected.canonicalTitle,
        normalizedName,
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
   * 重新确认官方候选并只采用服务器取得的字段。普通日区商品使用官方搜索 + 官方价格 API，升级包只读取本次批量
   * 关系证据；其它地区继续经页面解析器复核。所有分支都忽略浏览器自报的价格、封面和发行商。
   */
  private async resolveOfficialCandidate(
    anchor: OfficialProductCandidate,
    candidate: OfficialProductCandidate,
    matchSource: RegionalProductMatchSource,
    verifiedUpgrades: JapaneseUpgradeVerificationMap,
  ): Promise<OfficialProductCandidate> {
    if (candidate.regionCode === "JP") {
      if (candidate.productType === "upgrade-pack") {
        return this.readVerifiedJapaneseUpgrade({ anchor, candidate, matchSource }, verifiedUpgrades);
      }
      const verifiedJapanese = await this.japanese.resolve(anchor, candidate, matchSource);
      if (!verifiedJapanese) throw new SubscriptionConfirmationError("日区官方商品确认暂时失败，请重新核验其他地区后再试。");
      return verifiedJapanese;
    }
    const verified = await this.pages.resolve(candidate.regionCode, candidate.productUrl, new AbortController().signal);
    if (!verified) throw new SubscriptionConfirmationError("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");
    return verified;
  }

  /**
   * 关系签发状态与来源必须严格对应：automatic 不能借人工结论通过，manual_link 也不能复用自动结果。
   * 该读取同时服务 JP 默认锚点提升和单区验证，避免两处对同一 Map 产生不同信任规则。
   */
  private readVerifiedJapaneseUpgrade(
    item: JapaneseUpgradeConfirmationItem,
    verifiedUpgrades: JapaneseUpgradeVerificationMap,
  ): OfficialProductCandidate {
    const verification = verifiedUpgrades.get(japaneseUpgradeConfirmationKey(item));
    if (item.matchSource === "automatic" && verification?.status === "verified-automatic") return verification.candidate;
    if (item.matchSource === "manual_link" && verification?.status === "verified-manual") return verification.candidate;
    // 手动候选卡不能绕过 Browser 关系复核；错误文案继续按管理员选择路径区分，保持既有 API 契约。
    throw new SubscriptionConfirmationError(item.matchSource === "automatic"
      ? "日区升级包自动匹配已失效，请重新核验其他地区。"
      : "日区升级包官方链接无法确认，请重新核验。");
  }

  /**
   * 单区候选需通过官方重读、按来源分级的身份比较与本区价格 ID 二次验证后才可进入原子仓储事务。
   * 浏览器提供的 `matchSource` 只表达管理员/系统的审计路径，不能替代官方 URL 重验，也不能影响最终写入的官方字段。
   */
  private async validateRegion(
    region: ConfirmedRegionalProduct,
    selected: OfficialProductCandidate,
    relationshipAnchor: OfficialProductCandidate,
    verifiedUpgrades: JapaneseUpgradeVerificationMap,
  ): Promise<UnidentifiedValidatedRegion> {
    if (!isMatchSource(region.matchSource)) throw new SubscriptionConfirmationError("地区商品匹配来源无效。");
    const verified = await this.resolveOfficialCandidate(relationshipAnchor, region, region.matchSource, verifiedUpgrades);
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

/**
 * 从整批浏览器确认载荷只收集日区升级包，并始终使用对应订阅的默认区候选作为关系锚点。
 * 不在此去重或截断：重复键与三项上限由关系服务在任何外部调用前统一拒绝，避免静默少验证一项。
 */
function collectJapaneseUpgradeConfirmationItems(
  inputs: ConfirmedSubscriptionInput[],
  verifiedAnchors: OfficialProductCandidate[],
): JapaneseUpgradeConfirmationItem[] {
  return inputs.flatMap((input, inputIndex) => input.regions.flatMap((region) => {
    if (region.regionCode !== "JP" || region.productType !== "upgrade-pack") return [];
    // `matchSource` 是本地审计字段，不属于任天堂官方候选身份；显式拆分可防止它穿透到关系服务的 candidate 对象或外部适配边界。
    const { matchSource, ...candidate } = region;
    return [{ anchor: verifiedAnchors[inputIndex], candidate, matchSource }];
  }));
}

/** 匹配来源只接受产品已确认的三种值，服务层仍做运行时验证以防直接 API 或未来调用方绕开 TypeScript。 */
function isMatchSource(value: unknown): value is RegionalProductMatchSource {
  return value === "automatic" || value === "manual_selection" || value === "manual_link";
}

/**
 * 按来源决定最终确认的身份强度。`automatic` 没有管理员逐项选择，必须保持严格身份，
 * 或使用发现与日区复核都已验证的高置信度本地化身份；后者不依据翻译或模糊语义。
 * `manual_selection`/`manual_link` 则允许地区语言和发行商写法不同，但在 Node 服务已重验本区官方 URL 的前提下，
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

/** 仅把重新验证成功的本区官方 ID 写入地区商品；其他地区明确保存 null，不能跨区复用 ID。 */
function officialPriceIdOrNull(resolution: OfficialPriceIdResolution): string | null {
  return resolution.status === "official-available" ? resolution.officialPriceId : null;
}
