import { beforeEach, describe, expect, it } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import { SubscriptionRegionCompletionService } from "../src/services/subscription-region-completion-service";
import { InMemorySubscriptionConfirmationStore } from "./support/in-memory-business-stores";

// 外部服务工厂共享当前用例端口；beforeEach 必须替换实例，确保既有地区和历史哨兵不会跨测试泄漏。
let confirmationStore: InMemorySubscriptionConfirmationStore;

/**
 * 已有订阅地区补全使用平台中立端口夹具验证服务边界：补全只能追加经官方复核的缺失地区，
 * 绝不能替换既有美区商品、历史哨兵或订阅本身；真实跨表事务由 PostgreSQL 集成测试负责。
 */
describe("subscription region completion service", () => {
  const now = "2026-07-17T03:00:00.000Z";

  beforeEach(() => {
    // 每个用例从同一份只含美区的领域状态开始，避免前一用例新增的日区影响覆盖校验。
    confirmationStore = new InMemorySubscriptionConfirmationStore();
    seedUsOnlySubscription();
  });

  it("adds a validated missing region without changing existing history", async () => {
    const service = createService([overcookedUs(), overcookedJp()]);

    await expect(service.resolveExisting("subscription-overcooked")).resolves.toEqual([
      expect.objectContaining({ regionCode: "JP", status: "automatic", candidate: expect.objectContaining({ productUrl: overcookedJp().productUrl }) }),
    ]);
    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...overcookedJp(), matchSource: "automatic" }],
      skippedRegionCodes: [],
    }, now)).resolves.toEqual({ subscriptionId: "subscription-overcooked", addedRegionCodes: ["JP"] });

    // 旧快照是用户既有监控历史；原子补全只允许新增 JP 的商品与订阅关联，不能重建或覆盖它。
    await expect(readRegionCodes()).resolves.toEqual(["JP", "US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
  });

  it("writes nothing when one new regional official page cannot be validated", async () => {
    const service = createService([overcookedUs()]);

    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...overcookedJp(), matchSource: "manual_link" }],
      skippedRegionCodes: [],
    }, now)).rejects.toThrow("商品链接不是该区任天堂官方链接，或公开商品信息无法验证。");

    // 官方复核失败必须发生在仓储提交之前，不能留下地区商品或订阅关系的部分写入。
    await expect(readRegionCodes()).resolves.toEqual(["US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
  });

  it("adds a manually selected localized Japanese official candidate without replacing history", async () => {
    // 补全页与新建向导应使用相同的人工审计语义：本地化名称由管理员确认，
    // 但服务仍需重新解析本区官方 URL 并验证升级包类型，且只允许原子追加缺失地区。
    const service = createService([overcookedUs(), localizedOvercookedJp()]);

    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...localizedOvercookedJp(), matchSource: "manual_selection" }],
      skippedRegionCodes: [],
    }, now)).resolves.toEqual({ subscriptionId: "subscription-overcooked", addedRegionCodes: ["JP"] });
    await expect(readRegionCodes()).resolves.toEqual(["JP", "US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
  });

  it("rejects a localized manual candidate with a different product type without adding a region", async () => {
    // 人工候选不允许把同名本体、DLC 或组合包混进既有订阅；类型不一致时必须在仓储提交前失败，
    // 保证美区历史和现有地区关联均不发生部分更新。
    const invalidJapaneseUpgrade = { ...localizedOvercookedJp(), productType: "upgrade-pack" as const };
    const service = createService([overcookedUs(), invalidJapaneseUpgrade]);

    await expect(service.completeExisting("subscription-overcooked", {
      regions: [{ ...invalidJapaneseUpgrade, matchSource: "manual_link" }],
      skippedRegionCodes: [],
    }, now)).rejects.toThrow("地区商品与既有订阅身份不一致。");
    await expect(readRegionCodes()).resolves.toEqual(["US"]);
    await expect(readUsSnapshotCount()).resolves.toBe(1);
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
 * 平台中立仓储记录经验证的追加 DTO；PostgreSQL 专项测试继续验证真实事务、唯一约束和故障回滚。
 */
function createService(candidates: OfficialProductCandidate[]): SubscriptionRegionCompletionService {
  return new SubscriptionRegionCompletionService(
    confirmationStore,
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

/** 夹具模拟已有订阅只包含美区，并保留一条价格快照作为不得被补全改变的历史。 */
function seedUsOnlySubscription(): void {
  confirmationStore.seedExisting({
    anchor: overcookedUs(),
    historySnapshotCount: 1,
    confirmation: {
      game: {
        id: "game-overcooked",
        nameZh: "胡闹厨房 2",
        nameEn: "Overcooked! 2",
        normalizedName: "overcooked! 2|team17|game",
        publisher: "Team17",
        productType: "game",
        coverUrl: overcookedUs().coverUrl,
      },
      subscriptionId: "subscription-overcooked",
      regions: [{
        id: "product-overcooked-us",
        regionCode: "US",
        currency: "USD",
        officialPriceId: null,
        productUrl: overcookedUs().productUrl,
        matchSource: "manual_selection",
      }],
    },
  });
}

/** 读取当前订阅实际监控的地区，而不是游戏全部地区商品，确保补全确实创建了新的订阅关联。 */
async function readRegionCodes(): Promise<string[]> {
  return confirmationStore.regionCodes("subscription-overcooked");
}

/** 历史计数哨兵位于补全端口能力之外；服务追加地区时不得改变它。 */
async function readUsSnapshotCount(): Promise<number> {
  return confirmationStore.protectedState("subscription-overcooked")?.historySnapshotCount ?? 0;
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
