import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import { SubscriptionConfirmationRepository } from "../src/worker/repositories/subscription-confirmation-repository";
import { SubscriptionRegionCompletionService } from "../src/worker/services/subscription-region-completion-service";

/**
 * 已有订阅地区补全使用真实 D1 夹具验证写入边界：补全只能追加经官方复核的缺失地区，
 * 绝不能为了补全而替换既有美区商品、价格快照、目标价或订阅本身。
 */
describe("subscription region completion service", () => {
  const now = "2026-07-17T03:00:00.000Z";

  beforeEach(async () => {
    // 夹具按外键依赖倒序清理，避免此前用例的快照或目标价掩盖本次原子追加行为。
    await env.DB.exec("DELETE FROM price_snapshots; DELETE FROM subscription_region_targets; DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games;");
    await seedUsOnlySubscription();
  });

  it("adds a validated missing region without changing existing history or targets", async () => {
    const service = createService([overcookedUs(), overcookedJp()]);

    await expect(service.resolveExisting("subscription-overcooked")).resolves.toEqual([
      expect.objectContaining({ regionCode: "JP", status: "automatic", candidate: expect.objectContaining({ productUrl: overcookedJp().productUrl }) }),
    ]);
    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...overcookedJp(), matchSource: "automatic" }],
      skippedRegionCodes: [],
    }, now)).resolves.toEqual({ subscriptionId: "subscription-overcooked", addedRegionCodes: ["JP"] });

    // 旧快照和目标价是用户既有监控历史；原子补全只允许新增 JP 的商品与订阅关联，不能重建或覆盖它们。
    await expect(readRegionCodes()).resolves.toEqual(["JP", "US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
    await expect(readGlobalTarget()).resolves.toBe(5000);
  });

  it("writes nothing when one new regional official page cannot be validated", async () => {
    const service = createService([overcookedUs()]);

    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...overcookedJp(), matchSource: "manual_link" }],
      skippedRegionCodes: [],
    }, now)).rejects.toThrow("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");

    // 官方复核失败必须发生在 D1 批次之前，不能留下地区商品或关系表的部分写入。
    await expect(readRegionCodes()).resolves.toEqual(["US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
    await expect(readGlobalTarget()).resolves.toBe(5000);
  });

  it("adds a manually selected localized Japanese official candidate without replacing history", async () => {
    // 补全页与新建向导应使用相同的人工审计语义：本地化名称由管理员确认，
    // 但 Worker 仍需重新解析本区官方 URL 并验证升级包类型，且只允许原子追加缺失地区。
    const service = createService([overcookedUs(), localizedOvercookedJp()]);

    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...localizedOvercookedJp(), matchSource: "manual_selection" }],
      skippedRegionCodes: [],
    }, now)).resolves.toEqual({ subscriptionId: "subscription-overcooked", addedRegionCodes: ["JP"] });
    await expect(readRegionCodes()).resolves.toEqual(["JP", "US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
  });

  it("rejects a localized manual candidate with a different product type without adding a region", async () => {
    // 人工候选不允许把同名本体、DLC 或组合包混进既有订阅；类型不一致时必须在 D1 批次前失败，
    // 保证美区历史、目标价和现有地区关联均不发生部分更新。
    const invalidJapaneseUpgrade = { ...localizedOvercookedJp(), productType: "upgrade-pack" as const };
    const service = createService([overcookedUs(), invalidJapaneseUpgrade]);

    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...invalidJapaneseUpgrade, matchSource: "manual_link" }],
      skippedRegionCodes: [],
    }, now)).rejects.toThrow("地区商品与既有订阅身份不一致。");
    await expect(readRegionCodes()).resolves.toEqual(["US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
    await expect(readGlobalTarget()).resolves.toBe(5000);
  });

  it("continues to reject localized candidates that claim the automatic source", async () => {
    // 自动匹配没有管理员针对语言差异的选择动作，故必须继续满足完整逻辑身份；
    // 该用例防止人工来源的放宽规则意外扩展到自动补全，造成错误地区静默加入监控。
    const service = createService([overcookedUs(), localizedOvercookedJp()]);

    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...localizedOvercookedJp(), matchSource: "automatic" }],
      skippedRegionCodes: [],
    }, now)).rejects.toThrow("地区商品与既有订阅身份不一致。");
    await expect(readRegionCodes()).resolves.toEqual(["US"]);
  });
});

/**
 * 服务使用可注入官方页面、价格 ID、设置与跨区发现替身。替身只替代外部网络边界，
 * 仓储和原子写入仍走真实 D1，从而验证持久化不变量而非模拟调用次数。
 */
function createService(candidates: OfficialProductCandidate[]): SubscriptionRegionCompletionService {
  return new SubscriptionRegionCompletionService(
    new SubscriptionConfirmationRepository(env.DB),
    { resolve: async (regionCode, productUrl) => candidates.find((candidate) => candidate.regionCode === regionCode && candidate.productUrl === productUrl) ?? null },
    { resolve: async (candidate) => candidate.regionCode === "JP"
      ? { status: "official-available" as const, officialPriceId: "70050000064985" }
      : { status: "official-id-unavailable" as const, officialPriceId: null, reason: "unsupported-region" as const } },
    { get: async () => ({ enabledRegions: ["US" as const, "JP" as const] }) },
    { resolveRegions: async () => [{ candidateKey: `US:${overcookedUs().productUrl}`, regionCode: "JP" as const, status: "automatic" as const, candidate: overcookedJp() }] },
    (() => {
      let sequence = 0;
      return () => `completion-id-${++sequence}`;
    })(),
  );
}

/** 夹具模拟已有订阅只包含美区，并保留一条价格快照和人民币目标价作为不得被补全改变的历史。 */
async function seedUsOnlySubscription(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO games (id, name_zh, name_en, normalized_name, publisher, product_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind("game-overcooked", "胡闹厨房 2", "Overcooked! 2", "overcooked! 2|team17|game", "Team17", "game", "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .bind("product-overcooked-us", "game-overcooked", "US", "USD", overcookedUs().productUrl, "manual_selection", "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO subscriptions (id, game_id, enabled, global_target_cny_fen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("subscription-overcooked", "game-overcooked", 1, 5000, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
      .bind("subscription-overcooked", "product-overcooked-us"),
    env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("product-overcooked-us", 999, "USD", 6800, "official", "2026-07-16T00:00:00.000Z"),
  ]);
}

/** 读取当前订阅实际监控的地区，而不是游戏全部地区商品，确保补全确实创建了新的订阅关联。 */
async function readRegionCodes(): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT products.region_code AS regionCode FROM subscription_regions INNER JOIN regional_products AS products ON products.id = subscription_regions.regional_product_id WHERE subscription_regions.subscription_id = ? ORDER BY products.region_code ASC",
  ).bind("subscription-overcooked").all<{ regionCode: string }>();
  return result.results.map((row) => row.regionCode);
}

/** 美区快照计数是历史不被重写的直接证据；补全不应触及 `price_snapshots`。 */
async function readUsSnapshotCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM price_snapshots WHERE regional_product_id = ?").bind("product-overcooked-us").first<{ count: number }>();
  return row?.count ?? 0;
}

/** 全局目标价属于订阅配置，补全只添加地区映射，不能覆盖该字段。 */
async function readGlobalTarget(): Promise<number | null> {
  const row = await env.DB.prepare("SELECT global_target_cny_fen AS target FROM subscriptions WHERE id = ?").bind("subscription-overcooked").first<{ target: number | null }>();
  return row?.target ?? null;
}

/** 美区官方候选既是已有订阅的持久化锚点，也是跨区身份比较的起点。 */
function overcookedUs(): OfficialProductCandidate {
  return { regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-switch/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "USD", coverUrl: "https://assets.nintendo.com/overcooked-2.jpg", currentPriceMinor: 999, regularPriceMinor: 2499 };
}

/** 日区候选只在官方页面解析器成功返回时才可成为新增地区商品，浏览器载荷本身没有写入权限。 */
function overcookedJp(): OfficialProductCandidate {
  return { regionCode: "JP", productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game", currency: "JPY", coverUrl: "https://assets.nintendo.com/overcooked-2.jpg", currentPriceMinor: 1000, regularPriceMinor: null };
}

/** 日区夹具刻意使用本地化标题和发行商，验证补全服务不会把人工确认误当作严格自动匹配。 */
function localizedOvercookedJp(): OfficialProductCandidate {
  return { ...overcookedJp(), canonicalTitle: "オーバークック２", publisher: "Team17 Japan" };
}
