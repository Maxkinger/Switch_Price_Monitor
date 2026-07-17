import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

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
});

/** 用真实仓储连接 D1；官方页面与日区价格 ID 使用固定验证结果，使测试只覆盖最终确认业务规则。 */
function createService(candidates: OfficialProductCandidate[]): SubscriptionConfirmationService {
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
