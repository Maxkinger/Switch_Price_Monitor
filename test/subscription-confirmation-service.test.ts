import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import { SubscriptionConfirmationRepository } from "../src/worker/repositories/subscription-confirmation-repository";
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

  it("accepts a manually selected localized Japanese upgrade pack after official revalidation", async () => {
    // 管理员在日区候选卡中已审计了本地化标题；Worker 仍以重读后的官方 URL 和相同升级包类型为准，
    // 因此不能因为中日标题不同而拒绝这条合法映射，也不能采信浏览器自报的价格或发行商。
    const input = localizedUpgradeSubscription("manual_selection");
    const service = createService([overcookedUpgradeUs(), localizedOvercookedUpgradeJp()]);

    await expect(service.confirm([input], now)).resolves.toEqual([expect.objectContaining({ status: "created" })]);
    await expect(counts()).resolves.toEqual({ games: 1, products: 2, subscriptions: 1, regions: 2 });
  });

  it("accepts a manually linked localized Japanese upgrade pack after official revalidation", async () => {
    // 手动链接同样需要 Worker 成功重读本区任天堂页面，区别只在管理员提供 URL 而非点击候选卡；
    // 它可接受标题本地化，但仍必须与默认区保持同一升级包类型，不能成为绕过官方链接验证的路径。
    const input = localizedUpgradeSubscription("manual_link");
    const service = createService([overcookedUpgradeUs(), localizedOvercookedUpgradeJp()]);

    await expect(service.confirm([input], now)).resolves.toEqual([expect.objectContaining({ status: "created" })]);
    await expect(counts()).resolves.toEqual({ games: 1, products: 2, subscriptions: 1, regions: 2 });
  });

  it("rejects a manually selected localized candidate with a different product type before writing", async () => {
    // 手动选择仅放宽语言化标题与发行商，不是绕过商品分类的通行证；把游戏本体混入升级包订阅时，
    // 所有 D1 写入必须整体取消，避免后续价格采集把不同商品当成同一订阅地区。
    const invalidJapaneseGame = { ...localizedOvercookedUpgradeJp(), productType: "game" as const };
    const input = {
      ...localizedUpgradeSubscription("manual_selection"),
      regions: [
        { ...overcookedUpgradeUs(), matchSource: "manual_selection" as const },
        { ...invalidJapaneseGame, matchSource: "manual_selection" as const },
      ],
    };
    const service = createService([overcookedUpgradeUs(), invalidJapaneseGame]);

    await expect(service.confirm([input], now)).rejects.toThrow("地区商品与默认区商品身份不一致。");
    await expect(counts()).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("confirms one automatic localized Japanese candidate through official APIs without requesting the dynamic Store page", async () => {
    // `automatic` 只能来自当次唯一的官方跨语言匹配。日区 Store 页面在 Worker 中可能是动态外壳，
    // 因此本用例锁定最终确认必须改走日区双 API，且不能把页面解析器当作 JP 回退路径。
    const us = overcookedUpgradeUs();
    const japanese = localizedAutomaticOvercookedUpgradeJp();
    const pageResolver = { resolve: vi.fn(async (regionCode: string, productUrl: string) => regionCode === "US" && productUrl === us.productUrl ? us : null) };
    const japaneseResolver = { resolve: vi.fn(async () => japanese) };
    const service = new SubscriptionConfirmationService(
      new SubscriptionConfirmationRepository(env.DB),
      pageResolver,
      { resolve: async (candidate) => candidate.regionCode === "JP"
        ? { status: "official-available" as const, officialPriceId: "70010000106252" }
        : { status: "official-id-unavailable" as const, officialPriceId: null, reason: "unsupported-region" as const },
      },
      { get: async () => ({ enabledRegions: ["US" as const, "JP" as const] }) },
      japaneseResolver,
    );
    const input = localizedAutomaticUpgradeSubscription(us, japanese);

    await expect(service.confirm([input], now)).resolves.toEqual([expect.objectContaining({ status: "created" })]);
    // 地区候选在最终确认时还带有审计用的 matchSource；身份字段必须仍与管理员已选的日区官方候选一致。
    expect(japaneseResolver.resolve).toHaveBeenCalledWith(us, expect.objectContaining(japanese), "automatic");
    expect(pageResolver.resolve).not.toHaveBeenCalledWith("JP", expect.any(String), expect.any(AbortSignal));
    await expect(counts()).resolves.toEqual({ games: 1, products: 2, subscriptions: 1, regions: 2 });
  });

  it("rejects an automatic localized Japanese candidate when official API confirmation fails and writes no rows", async () => {
    // 搜索或价格 API 任一失败都不能降级为浏览器候选或动态页面解析；整批写入必须在 D1 批次前取消。
    const us = overcookedUpgradeUs();
    const japanese = localizedAutomaticOvercookedUpgradeJp();
    const service = new SubscriptionConfirmationService(
      new SubscriptionConfirmationRepository(env.DB),
      { resolve: async (regionCode, productUrl) => regionCode === "US" && productUrl === us.productUrl ? us : null },
      { resolve: async () => ({ status: "official-id-unavailable" as const, officialPriceId: null, reason: "official-verification-failed" as const }) },
      { get: async () => ({ enabledRegions: ["US" as const, "JP" as const] }) },
      { resolve: async () => null },
    );

    await expect(service.confirm([localizedAutomaticUpgradeSubscription(us, japanese)], now)).rejects.toThrow("日区官方商品确认暂时失败");
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
    automaticVerifier,
  );
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

/** 自动日区候选保留共同的拉丁主标题、版本标记、发行商和升级包类型，作为唯一高置信度身份的测试夹具。 */
function localizedAutomaticOvercookedUpgradeJp(): OfficialProductCandidate {
  return {
    ...localizedOvercookedUpgradeJp(),
    canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス",
    publisher: "Team17",
  };
}

/** 默认区和日区均需出现在确认载荷中；来源由调用方控制，用于分别锁定人工与自动的信任边界。 */
function localizedUpgradeSubscription(matchSource: "automatic" | "manual_selection" | "manual_link") {
  return {
    selected: overcookedUpgradeUs(),
    regions: [
      { ...overcookedUpgradeUs(), matchSource: "manual_selection" as const },
      { ...localizedOvercookedUpgradeJp(), matchSource },
    ],
    skippedRegionCodes: [],
  };
}

/** 默认区始终保留管理员点击的手动选择来源；日区条目才代表系统在跨区搜索中形成的自动证据。 */
function localizedAutomaticUpgradeSubscription(us: OfficialProductCandidate, japanese: OfficialProductCandidate) {
  return {
    selected: us,
    regions: [
      { ...us, matchSource: "manual_selection" as const },
      { ...japanese, matchSource: "automatic" as const },
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
