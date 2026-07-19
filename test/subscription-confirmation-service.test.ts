import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmedSubscriptionInput, OfficialProductCandidate, RegionalProductMatchSource } from "../src/shared/domain";
import { SubscriptionConfirmationRepository } from "../src/worker/repositories/subscription-confirmation-repository";
import {
  japaneseUpgradeConfirmationKey,
  type JapaneseUpgradeConfirmationItem,
  type JapaneseUpgradeRelationService,
} from "../src/worker/services/japanese-upgrade-relation-service";
import { SubscriptionConfirmationService } from "../src/worker/services/subscription-confirmation-service";

/**
 * 最终确认服务测试使用真实测试 D1 与可注入的官方解析桩件。这样可验证一批写入的原子边界，
 * 同时不向任天堂真实页面或价格接口发请求，也不会把外部响应带入数据库断言。
 */
describe("subscription confirmation service", () => {
  const now = "2026-07-17T02:00:00.000Z";

  beforeEach(async () => {
    // 依赖顺序倒序清理，保证每个用例都从“尚未最终确认”的空业务数据开始，外键不会遮蔽原子性断言。
    await env.DB.exec("DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games;");
  });

  it("verifies all Japanese upgrade regions once before the atomic confirmation batch", async () => {
    // 两款升级包必须在任何设置读取、既有订阅查询或 D1 写入前组成一个受限批次；逐游戏调用会绕过三项 Browser Run 总上限。
    const first = japaneseUpgradeCase("overcooked-2", "70050000064985");
    const second = japaneseUpgradeCase("kirby-2", "70050000064986");
    const japaneseUpgrades = {
      verifyForConfirmation: vi.fn().mockResolvedValue(new Map([
        [japaneseUpgradeConfirmationKey(first.item), { status: "verified-automatic", candidate: first.item.candidate }],
        [japaneseUpgradeConfirmationKey(second.item), { status: "verified-automatic", candidate: second.item.candidate }],
      ])),
    };
    const service = createServiceWithJapaneseUpgradeVerifier(japaneseUpgrades, [first, second]);

    await expect(service.confirm([first.input, second.input], now)).resolves.toHaveLength(2);
    expect(japaneseUpgrades.verifyForConfirmation).toHaveBeenCalledExactlyOnceWith([first.item, second.item]);
    await expect(counts()).resolves.toEqual({ games: 2, products: 4, subscriptions: 2, regions: 4 });
  });

  it("writes zero rows when one automatic Japanese upgrade relation is rejected", async () => {
    // 自动关系只要一项缺少本次 Browser 与价格证据，整个确认请求就必须在生成 ID 和 D1 批次之前失败，不能部分保存第一款游戏。
    const first = japaneseUpgradeCase("overcooked-2", "70050000064985");
    const second = japaneseUpgradeCase("kirby-2", "70050000064986");
    const japaneseUpgrades = {
      verifyForConfirmation: vi.fn().mockResolvedValue(new Map([
        [japaneseUpgradeConfirmationKey(first.item), { status: "verified-automatic", candidate: first.item.candidate }],
        [japaneseUpgradeConfirmationKey(second.item), { status: "rejected" }],
      ])),
    };

    await expect(createServiceWithJapaneseUpgradeVerifier(japaneseUpgrades, [first, second]).confirm([first.input, second.input], now))
      .rejects.toThrow("日区升级包自动匹配已失效");
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("accepts a manually linked Japanese upgrade only after batch relation verification", async () => {
    // 人工链接只是 Browser 安全失败时的受控兜底；保存前仍需关系服务以根商品、官方 URL 与 JP/JPY 报价重新签发 verified-manual。
    const fixture = japaneseUpgradeCase("overcooked-2", "70050000064985", "manual_link");
    const japaneseUpgrades = { verifyForConfirmation: vi.fn().mockResolvedValue(new Map([
      [japaneseUpgradeConfirmationKey(fixture.item), { status: "verified-manual", candidate: fixture.item.candidate }],
    ])) };

    await expect(createServiceWithJapaneseUpgradeVerifier(japaneseUpgrades, [fixture]).confirm([fixture.input], now))
      .resolves.toEqual([expect.objectContaining({ status: "created" })]);
    expect(japaneseUpgrades.verifyForConfirmation).toHaveBeenCalledExactlyOnceWith([fixture.item]);
  });

  it("rejects a manually linked Japanese upgrade before every D1 write when relation evidence is missing", async () => {
    // 人工 URL 不能降低最终安全门槛；关系服务拒绝时必须返回与自动失效不同的可操作文案，并保持四张业务表为空。
    const fixture = japaneseUpgradeCase("overcooked-2", "70050000064985", "manual_link");
    const japaneseUpgrades = { verifyForConfirmation: vi.fn().mockResolvedValue(new Map([
      [japaneseUpgradeConfirmationKey(fixture.item), { status: "rejected" }],
    ])) };

    await expect(createServiceWithJapaneseUpgradeVerifier(japaneseUpgrades, [fixture]).confirm([fixture.input], now))
      .rejects.toThrow("日区升级包官方链接无法确认，请重新核验。");
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("uses the freshly resolved default-region anchor for Japanese upgrade relation verification", async () => {
    // 浏览器可保留真实美区 URL 却篡改标题和发行商；若关系服务先消费该文本，manual_link 的同类型规则可能把另一游戏的日区升级包错误绑定到真实订阅。
    const actualAnchor = japaneseUpgradeCase("actual-game-2", "70050000064985").input.selected;
    const spoofedAnchor = { ...actualAnchor, canonicalTitle: "spoofed-game-2 Nintendo Switch 2 Edition Upgrade Pack", publisher: "Spoofed Publisher" };
    const japaneseCandidate: OfficialProductCandidate = {
      ...spoofedAnchor,
      regionCode: "JP",
      productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
      currency: "JPY",
      currentPriceMinor: 1000,
    };
    const input: ConfirmedSubscriptionInput = {
      selected: spoofedAnchor,
      regions: [
        { ...spoofedAnchor, matchSource: "manual_selection" },
        { ...japaneseCandidate, matchSource: "manual_link" },
      ],
      skippedRegionCodes: [],
    };
    const japaneseUpgrades = {
      verifyForConfirmation: vi.fn(async (items: JapaneseUpgradeConfirmationItem[]) => {
        const item = items[0];
        // 真实关系服务会按锚点官方身份重新搜索根商品：只有仍使用伪造文本时才模拟错误成功，官方重读后的真实锚点必须拒绝这条日区关系。
        return new Map([[japaneseUpgradeConfirmationKey(item), item.anchor.canonicalTitle === spoofedAnchor.canonicalTitle
          ? { status: "verified-manual" as const, candidate: japaneseCandidate }
          : { status: "rejected" as const }]]);
      }),
    };
    const service = new SubscriptionConfirmationService(
      new SubscriptionConfirmationRepository(env.DB),
      { resolve: async (regionCode, productUrl) => regionCode === "US" && productUrl === actualAnchor.productUrl ? actualAnchor : null },
      { resolve: async (candidate) => candidate.regionCode === "JP"
        ? { status: "official-available" as const, officialPriceId: "70050000064985" }
        : { status: "official-id-unavailable" as const, officialPriceId: null, reason: "unsupported-region" as const },
      },
      { get: async () => ({ enabledRegions: ["US" as const, "JP" as const] }) },
      { resolve: async () => null },
      japaneseUpgrades,
    );

    await expect(service.confirm([input], now)).rejects.toThrow("日区升级包官方链接无法确认，请重新核验。");
    expect(japaneseUpgrades.verifyForConfirmation).toHaveBeenCalledWith([
      expect.objectContaining({ anchor: actualAnchor, candidate: japaneseCandidate, matchSource: "manual_link" }),
    ]);
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("keeps ordinary Japanese games on the existing double-official resolver", async () => {
    // 普通日区游戏没有升级关系页，不得消耗 Browser Run；确认服务仍应以空升级批次调用关系验证器，并把 JP 游戏交给既有双官方 API。
    const japaneseUpgrades = { verifyForConfirmation: vi.fn().mockResolvedValue(new Map()) };
    const japaneseResolver = { resolve: vi.fn(async (_anchor, candidate) => candidate) };
    const service = createServiceWithJapaneseUpgradeVerifier(japaneseUpgrades, [], japaneseResolver, [overcookedUs()]);

    await expect(service.confirm([overcookedSubscription()], now)).resolves.toEqual([expect.objectContaining({ status: "created" })]);
    expect(japaneseUpgrades.verifyForConfirmation).toHaveBeenCalledExactlyOnceWith([]);
    expect(japaneseResolver.resolve).toHaveBeenCalledWith(overcookedUs(), expect.objectContaining(overcookedJp()), "automatic");
  });

  it("writes no business records when one selected game repeats a regional mapping", async () => {
    const valid = overcookedSubscription();
    const invalidDuplicateUs = { ...valid, regions: [...valid.regions, { ...valid.regions[0] }] };
    const service = createService(allFixtureCandidates());

    await expect(service.confirm([valid, invalidDuplicateUs], now)).rejects.toThrow("每个游戏在每区只能确认一个商品。");
    // 所有输入均应在调用 D1 批次前完成验证；重复地区不能留下游戏、商品、订阅或关联半成品。
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("creates two independent subscriptions and their regional products in one confirmation", async () => {
    const service = createService(allFixtureCandidates());

    await expect(service.confirm([overcookedSubscription(), kirbySubscription()], now)).resolves.toEqual([
      expect.objectContaining({ status: "created" }),
      expect.objectContaining({ status: "created" }),
    ]);
    // 两个游戏各确认两区，所有主档、地区商品、订阅和关联都必须同时出现，不能仅创建其中一个游戏。
    await expect(counts()).resolves.toEqual({ games: 2, products: 4, subscriptions: 2, regions: 4 });
  });

  it("returns an existing logical game subscription without replacing its confirmed regions", async () => {
    await seedExistingOvercooked(now);
    const service = createService(allFixtureCandidates());

    await expect(service.confirm([overcookedSubscription()], now)).resolves.toEqual([
      { gameId: "game-overcooked", subscriptionId: "subscription-overcooked", status: "existing" },
    ]);
    // 已有订阅可能只监控美区；后续批量确认不能趁机新增日区或修改用户既有地区范围。
    await expect(existingRegionIds()).resolves.toEqual(["product-overcooked-us"]);
  });

  it("rejects a configured region that is neither confirmed nor explicitly skipped", async () => {
    // Worker 必须在写入前以保存的 US/JP 设置检查覆盖范围；仅默认区的旧页面提交不能静默形成美区单区订阅。
    const input = { ...overcookedSubscription(), regions: [{ ...overcookedUs(), matchSource: "manual_selection" as const }], skippedRegionCodes: [] };
    const service = createService(allFixtureCandidates(), ["US", "JP"]);

    await expect(service.confirm([input], now)).rejects.toThrow("请确认或跳过所有已启用地区。");
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("accepts an explicitly skipped configured region without creating an unverified mapping", async () => {
    // 跳过是管理员可审计的明确决定，而非把 JP 价格或链接猜测为 US 商品；因此只写入已确认的默认区映射。
    const input = { ...overcookedSubscription(), regions: [{ ...overcookedUs(), matchSource: "manual_selection" as const }], skippedRegionCodes: ["JP" as const] };
    const service = createService(allFixtureCandidates(), ["US", "JP"]);

    await expect(service.confirm([input], now)).resolves.toEqual([expect.objectContaining({ status: "created" })]);
    await expect(counts()).resolves.toEqual({ games: 1, products: 1, subscriptions: 1, regions: 1 });
  });

  it("rejects a manually selected localized candidate with a different product type before writing", async () => {
    // 手动选择仅放宽语言化标题与发行商，不是绕过商品分类的通行证；把游戏本体混入升级包订阅时，
    // 所有 D1 写入必须整体取消，避免后续价格采集把不同商品当成同一订阅地区。
    const invalidJapaneseGame = { ...localizedOvercookedUpgradeJp(), productType: "game" as const };
    const input = {
      ...localizedManualSelectionUpgradeSubscription(),
      regions: [
        { ...overcookedUpgradeUs(), matchSource: "manual_selection" as const },
        { ...invalidJapaneseGame, matchSource: "manual_selection" as const },
      ],
    };
    const service = createService([overcookedUpgradeUs(), invalidJapaneseGame]);

    await expect(service.confirm([input], now)).rejects.toThrow("地区商品与默认区商品身份不一致。");
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("writes a Hong Kong automatic bundle only after fresh regional discovery proves the same URL", async () => {
    // 非日区 automatic 没有管理员逐项确认；页面身份重读后还必须重新执行跨区唯一性发现，防止过期候选在官方新增同版本时继续写入。
    const automaticVerifier = { verifyAutomaticRegionalCandidate: vi.fn().mockResolvedValue(true) };
    const service = createHongKongBundleService(automaticVerifier);
    const input = hongKongBundleSubscription("automatic");

    await expect(service.confirm([input], now)).resolves.toEqual([expect.objectContaining({ status: "created" })]);
    expect(automaticVerifier.verifyAutomaticRegionalCandidate).toHaveBeenCalledWith(overcookedGourmetUs(), overcookedGourmetHk());
    await expect(counts()).resolves.toEqual({ games: 1, products: 2, subscriptions: 1, regions: 2 });
  });

  it("rejects an expired Hong Kong automatic bundle before any D1 write", async () => {
    // 重新发现不再得到同一唯一 URL 时必须整批失败；不能降级为人工选择，也不能先写默认区后留下半成品订阅。
    const automaticVerifier = { verifyAutomaticRegionalCandidate: vi.fn().mockResolvedValue(false) };
    const service = createHongKongBundleService(automaticVerifier);

    await expect(service.confirm([hongKongBundleSubscription("automatic")], now)).rejects.toThrow("地区商品自动匹配已失效，请重新核验其他地区。");
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("keeps a manually selected Hong Kong bundle independent from automatic discovery", async () => {
    // 管理员已明确点击本区候选时仍需官方详情和同类型校验，但不应调用 automatic 唯一性验证器；否则人工补救会被自动搜索可用性错误阻断。
    const automaticVerifier = { verifyAutomaticRegionalCandidate: vi.fn().mockResolvedValue(false) };
    const service = createHongKongBundleService(automaticVerifier);

    await expect(service.confirm([hongKongBundleSubscription("manual_selection")], now)).resolves.toEqual([expect.objectContaining({ status: "created" })]);
    expect(automaticVerifier.verifyAutomaticRegionalCandidate).not.toHaveBeenCalled();
    await expect(counts()).resolves.toEqual({ games: 1, products: 2, subscriptions: 1, regions: 2 });
  });
});

/**
 * 港区最终确认夹具显式注入自动发现验证器；页面解析桩仅按 URL 返回服务器重读候选，
 * 价格 ID 保持不支持地区，证明本组测试只改变 automatic 唯一性门禁而不伪造港区报价。
 */
function createHongKongBundleService(automaticVerifier: { verifyAutomaticRegionalCandidate(anchor: OfficialProductCandidate, candidate: OfficialProductCandidate): Promise<boolean> }): SubscriptionConfirmationService {
  const candidates = [overcookedGourmetUs(), overcookedGourmetHk()];
  return new SubscriptionConfirmationService(
    new SubscriptionConfirmationRepository(env.DB),
    { resolve: async (regionCode, productUrl) => candidates.find((candidate) => candidate.regionCode === regionCode && candidate.productUrl === productUrl) ?? null },
    { resolve: async () => ({ status: "official-id-unavailable" as const, officialPriceId: null, reason: "unsupported-region" as const }) },
    { get: async () => ({ enabledRegions: ["US" as const, "HK" as const] }) },
    { resolve: async () => null },
    // 港区用例不包含日区升级包；空 Map 证明新依赖不会改变非日区 automatic 的独立唯一性门禁。
    { verifyForConfirmation: async () => new Map() },
    automaticVerifier,
  );
}

/**
 * 构造任务 7 的真实 D1 确认服务，只替换外部官方边界。页面解析器仅允许夹具中的美区锚点，
 * 日区升级候选必须来自批量关系 Map；价格 ID 从严格 D 数字 URL 导出，避免测试以固定单一 ID 掩盖多商品串项。
 */
function createServiceWithJapaneseUpgradeVerifier(
  japaneseUpgrades: Pick<JapaneseUpgradeRelationService, "verifyForConfirmation">,
  fixtures: JapaneseUpgradeTestCase[],
  japaneseResolver: { resolve(anchor: OfficialProductCandidate, candidate: OfficialProductCandidate, matchSource: RegionalProductMatchSource): Promise<OfficialProductCandidate | null> } = { resolve: async () => null },
  ordinaryPageCandidates: OfficialProductCandidate[] = [],
): SubscriptionConfirmationService {
  const anchors = [...fixtures.map((fixture) => fixture.input.selected), ...ordinaryPageCandidates];
  return new SubscriptionConfirmationService(
    new SubscriptionConfirmationRepository(env.DB),
    { resolve: async (regionCode, productUrl) => anchors.find((candidate) => candidate.regionCode === regionCode && candidate.productUrl === productUrl) ?? null },
    {
      resolve: async (candidate) => {
        if (candidate.regionCode !== "JP") return { status: "official-id-unavailable" as const, officialPriceId: null, reason: "unsupported-region" as const };
        const priceId = /^https:\/\/store-jp\.nintendo\.com\/item\/software\/D(\d+)\/$/.exec(candidate.productUrl)?.[1];
        return priceId
          ? { status: "official-available" as const, officialPriceId: priceId }
          : { status: "official-id-unavailable" as const, officialPriceId: null, reason: "official-verification-failed" as const };
      },
    },
    { get: async () => ({ enabledRegions: ["US" as const, "JP" as const] }) },
    japaneseResolver,
    japaneseUpgrades,
  );
}

/** 一个升级包夹具同时提供浏览器确认载荷和关系服务精确键输入，防止测试分别手写后发生 URL、来源或锚点漂移。 */
interface JapaneseUpgradeTestCase {
  input: ConfirmedSubscriptionInput;
  item: JapaneseUpgradeConfirmationItem;
}

/**
 * 为多商品批量生成互不相同的美区锚点、日区升级 URL 与标题；相同标题跨区可让本测试聚焦关系证据，
 * 而不把跨语言标题算法重复混入保存前批处理断言。
 */
function japaneseUpgradeCase(
  slug: string,
  priceId: string,
  matchSource: Extract<RegionalProductMatchSource, "automatic" | "manual_link"> = "automatic",
): JapaneseUpgradeTestCase {
  const title = `${slug} Nintendo Switch 2 Edition Upgrade Pack`;
  const anchor: OfficialProductCandidate = {
    regionCode: "US",
    productUrl: `https://www.nintendo.com/us/store/products/${slug}-nintendo-switch-2-edition-upgrade-pack/`,
    canonicalTitle: title,
    publisher: "Nintendo Test Publisher",
    productType: "upgrade-pack",
    currency: "USD",
    coverUrl: null,
    currentPriceMinor: 999,
    regularPriceMinor: null,
  };
  const candidate: OfficialProductCandidate = {
    ...anchor,
    regionCode: "JP",
    productUrl: `https://store-jp.nintendo.com/item/software/D${priceId}/`,
    currency: "JPY",
    currentPriceMinor: 1000,
  };
  const input: ConfirmedSubscriptionInput = {
    selected: anchor,
    regions: [
      { ...anchor, matchSource: "manual_selection" },
      { ...candidate, matchSource },
    ],
    skippedRegionCodes: [],
  };
  return { input, item: { anchor, candidate, matchSource } };
}

/** 用真实仓储连接 D1；官方页面与日区价格 ID 使用固定验证结果，使测试只覆盖最终确认业务规则。 */
function createService(candidates: OfficialProductCandidate[], enabledRegions: Array<"US" | "JP"> = ["US", "JP"]): SubscriptionConfirmationService {
  return new SubscriptionConfirmationService(
    new SubscriptionConfirmationRepository(env.DB),
    {
      resolve: async (regionCode, productUrl) => candidates.find((candidate) => candidate.regionCode === regionCode && candidate.productUrl === productUrl) ?? null,
    },
    {
      resolve: async (candidate) => candidate.regionCode === "JP"
        ? { status: "official-available" as const, officialPriceId: "70050000064985" }
        : { status: "official-id-unavailable" as const, officialPriceId: null, reason: "unsupported-region" as const },
    },
    // 设置替身让确认服务按已保存地区校验覆盖范围，不依赖浏览器候选所携带的地区集合。
    { get: async () => ({ enabledRegions }) },
    // 默认日区替身只返回同 URL 的已验证官方候选；专项用例会单独替换它，以覆盖动态页面绕过和 API 失败边界。
    { resolve: async (_anchor, candidate) => candidates.find((option) => option.regionCode === "JP" && option.productUrl === candidate.productUrl) ?? null },
    // 普通游戏夹具没有日区升级包；显式空批次依赖锁定构造参数顺序，避免 automatic verifier 被错位注入。
    { verifyForConfirmation: async () => new Map() },
  );
}

/** 默认区的用户选择也必须被最终服务重新解析；`manual_selection` 表示管理员从官方候选卡明确选择该商品。 */
function overcookedSubscription() {
  return {
    selected: overcookedUs(),
    regions: [
      { ...overcookedUs(), matchSource: "manual_selection" as const },
      { ...overcookedJp(), matchSource: "automatic" as const },
    ],
    skippedRegionCodes: [],
  };
}

/** 第二个游戏用于证明批量确认不会因前一个游戏的地区映射而覆盖或串联后一个游戏。 */
function kirbySubscription() {
  return {
    selected: kirbyUs(),
    regions: [
      { ...kirbyUs(), matchSource: "manual_selection" as const },
      { ...kirbyJp(), matchSource: "manual_link" as const },
    ],
    skippedRegionCodes: [],
  };
}

/** 所有输入候选均由本测试的官方解析桩件返回；URL、币种与商品类型跨区独立，防止测试掩盖串区错误。 */
function allFixtureCandidates(): OfficialProductCandidate[] {
  return [overcookedUs(), overcookedJp(), kirbyUs(), kirbyJp()];
}

function overcookedUs(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "USD", coverUrl: "https://assets.nintendo.com/overcooked-2.jpg", currentPriceMinor: 999, regularPriceMinor: 2499 };
}

function overcookedJp(): OfficialProductCandidate {
  return { regionCode: "JP", productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "JPY", coverUrl: "https://assets.nintendo.com/overcooked-2.jpg", currentPriceMinor: 1000, regularPriceMinor: null };
}

function kirbyUs(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/kirby-and-the-forgotten-land-switch/", canonicalTitle: "Kirby and the Forgotten Land", publisher: "Nintendo", productType: "game", currency: "USD", coverUrl: null, currentPriceMinor: 5999, regularPriceMinor: null };
}

function kirbyJp(): OfficialProductCandidate {
  return { regionCode: "JP", productUrl: "https://store-jp.nintendo.com/item/software/D70010000000001/", canonicalTitle: "Kirby and the Forgotten Land", publisher: "Nintendo", productType: "game", currency: "JPY", coverUrl: null, currentPriceMinor: 6500, regularPriceMinor: null };
}

/** 构造升级包锚点，明确与完整游戏不同，防止本地化确认测试意外复用普通游戏的宽松路径。 */
function overcookedUpgradeUs(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-upgrade-pack/", canonicalTitle: "Overcooked! 2 Nintendo Switch 2 Edition Upgrade Pack", publisher: "Team17", productType: "upgrade-pack", currency: "USD", coverUrl: null, currentPriceMinor: 999, regularPriceMinor: null };
}

/** 日区候选采用与美区不同的官方标题和发行商写法，但其受控类型仍是同一个升级包。 */
function localizedOvercookedUpgradeJp(): OfficialProductCandidate {
  return { regionCode: "JP", productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/", canonicalTitle: "オーバークック２ Nintendo Switch 2 Edition アップグレードパス", publisher: "Team17 Japan", productType: "upgrade-pack", currency: "JPY", coverUrl: null, currentPriceMinor: 1000, regularPriceMinor: null };
}

/** 手动候选类型不一致用例保留完整两区载荷；关系服务只收集仍为 upgrade-pack 的日区项，不会替错误 game 候选背书。 */
function localizedManualSelectionUpgradeSubscription() {
  return {
    selected: overcookedUpgradeUs(),
    regions: [
      { ...overcookedUpgradeUs(), matchSource: "manual_selection" as const },
      { ...localizedOvercookedUpgradeJp(), matchSource: "manual_selection" as const },
    ],
    skippedRegionCodes: [],
  };
}

/** 美区 Gourmet 组合商品是港区自动发现的默认区锚点；发行商和类型用于写入前跨区身份比较。 */
function overcookedGourmetUs(): OfficialProductCandidate {
  return {
    regionCode: "US",
    productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-gourmet-edition-switch/",
    canonicalTitle: "Overcooked! 2 - Gourmet Edition",
    publisher: "Team17",
    productType: "bundle",
    currency: "USD",
    coverUrl: null,
    currentPriceMinor: 3999,
    regularPriceMinor: null,
  };
}

/** 港区组合候选使用经详情绑定的 bundles URL；测试不提供价格，避免把关联发现引用误当成报价来源。 */
function overcookedGourmetHk(): OfficialProductCandidate {
  return {
    ...overcookedGourmetUs(),
    regionCode: "HK",
    productUrl: "https://ec.nintendo.com/HK/zh/bundles/70070000010913",
    currency: "HKD",
    currentPriceMinor: null,
  };
}

/** 默认区保留人工选择来源，港区来源由用例切换；这样只测试非日区 automatic 门禁，不改变默认区信任规则。 */
function hongKongBundleSubscription(matchSource: "automatic" | "manual_selection") {
  return {
    selected: overcookedGourmetUs(),
    regions: [
      { ...overcookedGourmetUs(), matchSource: "manual_selection" as const },
      { ...overcookedGourmetHk(), matchSource },
    ],
    skippedRegionCodes: [],
  };
}

/** 既有记录使用与服务约定相同的稳定身份，模拟管理员之前已确认的美区订阅。 */
async function seedExistingOvercooked(now: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO games (id, name_zh, name_en, normalized_name, publisher, product_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("game-overcooked", "Overcooked! 2", "Overcooked! 2", "overcooked! 2|team17|game", "Team17", "game", now),
    env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)").bind("product-overcooked-us", "game-overcooked", "US", "USD", overcookedUs().productUrl, "manual_selection", now),
    env.DB.prepare("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)").bind("subscription-overcooked", "game-overcooked", now, now),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind("subscription-overcooked", "product-overcooked-us"),
  ]);
}

/** 返回四张核心表计数，直接证明确认失败时没有半成品、成功时关系表也同时建立。 */
async function counts(): Promise<{ games: number; products: number; subscriptions: number; regions: number }> {
  const [games, products, subscriptions, regions] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM games"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM regional_products"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_regions"),
  ]);
  return {
    games: (games.results[0] as { count: number } | undefined)?.count ?? 0,
    products: (products.results[0] as { count: number } | undefined)?.count ?? 0,
    subscriptions: (subscriptions.results[0] as { count: number } | undefined)?.count ?? 0,
    regions: (regions.results[0] as { count: number } | undefined)?.count ?? 0,
  };
}

/** 只读取已有订阅的关联，验证本任务绝不隐式替换地区范围。 */
async function existingRegionIds(): Promise<string[]> {
  const result = await env.DB.prepare("SELECT regional_product_id AS productId FROM subscription_regions WHERE subscription_id = ? ORDER BY regional_product_id").bind("subscription-overcooked").all<{ productId: string }>();
  return result.results.map((row) => row.productId);
}
