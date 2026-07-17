import type {
  ConfirmedRegionalProduct,
  ConfirmedSubscriptionInput,
  OfficialProductCandidate,
  RegionalProductMatchSource,
  SubscriptionConfirmationResult,
} from "../../shared/domain";
import type { OfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import {
  SubscriptionConfirmationRepository,
  type ValidatedConfirmedRegion,
  type ValidatedSubscriptionConfirmation,
} from "../repositories/subscription-confirmation-repository";
import type { OfficialPriceIdResolution, OfficialPriceIdService } from "./official-price-id-service";

/** 服务仅需要官方价格 ID 的只读解析能力，窄接口使测试不必创建真实官方网络适配器。 */
type OfficialPriceIdResolver = Pick<OfficialPriceIdService, "resolve">;

/** 最终确认的可预期表单/官方身份错误；路由会将其安全映射为 422，不暴露外部页面或 D1 细节。 */
export class SubscriptionConfirmationError extends Error {}

/**
 * 最终确认服务是“瞬时发现 DTO”到“可采集订阅记录”的唯一业务闸门。它始终重读官方商品页，
 * 用重新验证的标题、币种、类型、发行商和价格 ID 生成写入数据，绝不把浏览器自报的候选身份直接持久化。
 */
export class SubscriptionConfirmationService {
  public constructor(
    private readonly repository: SubscriptionConfirmationRepository,
    private readonly pages: OfficialNintendoProductPageResolver,
    private readonly officialPriceIds: OfficialPriceIdResolver,
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
   * 否则同名 DLC、本体或升级包可能被混入同一订阅，污染后续价格历史和日报。
   */
  private async validate(input: ConfirmedSubscriptionInput): Promise<UnidentifiedValidatedSubscription> {
    if (!Array.isArray(input.regions) || input.regions.length === 0) throw new SubscriptionConfirmationError("每个游戏至少确认一个地区商品。");
    const selected = await this.resolveOfficialCandidate(input.selected);
    const regions = await Promise.all(input.regions.map((region) => this.validateRegion(region, selected)));
    if (new Set(regions.map((region) => region.regionCode)).size !== regions.length) {
      throw new SubscriptionConfirmationError("每个游戏在每区只能确认一个商品。");
    }
    const selectedRegions = regions.filter((region) => region.regionCode === selected.regionCode && region.productUrl === selected.productUrl);
    if (selectedRegions.length !== 1) throw new SubscriptionConfirmationError("默认区商品必须在确认地区中保留一次。");

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

  /** 重新请求官方链接并只采用其返回字段；浏览器提交的价格、封面和发行商均被刻意忽略。 */
  private async resolveOfficialCandidate(candidate: OfficialProductCandidate): Promise<OfficialProductCandidate> {
    const verified = await this.pages.resolve(candidate.regionCode, candidate.productUrl, new AbortController().signal);
    if (!verified) throw new SubscriptionConfirmationError("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");
    return verified;
  }

  /** 单区候选需通过官方重读、同一逻辑身份比较与本区价格 ID 二次验证后才可进入 D1 批次。 */
  private async validateRegion(region: ConfirmedRegionalProduct, selected: OfficialProductCandidate): Promise<UnidentifiedValidatedRegion> {
    if (!isMatchSource(region.matchSource)) throw new SubscriptionConfirmationError("地区商品匹配来源无效。");
    const verified = await this.resolveOfficialCandidate(region);
    if (!hasSameLogicalIdentity(selected, verified)) throw new SubscriptionConfirmationError("地区商品与默认区商品身份不一致。");
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

/** 同一逻辑游戏的确认比较忽略大小写和多余空白；发行商仅在双方都有时作为同名商品的附加防线。 */
function hasSameLogicalIdentity(left: OfficialProductCandidate, right: OfficialProductCandidate): boolean {
  if (normalize(left.canonicalTitle) !== normalize(right.canonicalTitle) || left.productType !== right.productType) return false;
  return left.publisher === null || right.publisher === null || normalize(left.publisher) === normalize(right.publisher);
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
