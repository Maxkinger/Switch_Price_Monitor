import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import { GameNameRepository } from "../src/worker/repositories/game-name-repository";
import {
  GameNameSyncError,
  GameNameSyncService,
} from "../src/worker/services/game-name-sync-service";

/**
 * 既有名称同步测试保留真实 D1 联表、订阅归属与来源更新，只替换任天堂外部名称解析结果；
 * 这样既不会发起网络请求，也能防止纯 mock 掩盖跨订阅改名、错误锚点或来源未落盘的问题。
 */
describe("GameNameSyncService", () => {
  const now = "2026-07-26T08:00:00.000Z";

  beforeEach(async () => {
    // 反向清理四张业务表并重建一条带 US/HK 官方映射的历史订阅，保证每个用例独立验证同一受控订阅归属。
    await env.DB.exec("DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games;");
    await seedKirbySubscription(now);
  });

  it("updates a pending game immediately when an official name is available", async () => {
    // 历史待同步项一旦取得大陆同 ID 官方标题，应立即保存名称和来源，不再要求管理员重复确认可核验的官方事实。
    const service = createSyncService({
      resolveOfficialName: async () => ({ kind: "mainland_official" as const, nameZh: "星之卡比 探索发现" }),
    });

    await expect(service.sync(["sub-kirby"], now)).resolves.toEqual([
      { subscriptionId: "sub-kirby", status: "updated_official", nameEn: "Kirby and the Forgotten Land" },
    ]);
    await expect(readKirbyGame()).resolves.toEqual({
      nameZh: "星之卡比 探索发现",
      nameZhSource: "mainland_official",
    });
  });

  it("returns the official English title for a decision when official Chinese is unavailable", async () => {
    // 无唯一香港候选或大陆同 ID 页面时不得猜测名称；同步只返回受仓储约束的英文标题，等待管理员明确选择人工中文或英文回退。
    const service = createSyncService({
      resolveOfficialName: async () => ({ kind: "unavailable" as const }),
    });

    await expect(service.sync(["sub-kirby"], now)).resolves.toEqual([
      { subscriptionId: "sub-kirby", status: "needs-decision", nameEn: "Kirby and the Forgotten Land" },
    ]);
    await expect(readKirbyGame()).resolves.toEqual({
      nameZh: "Kirby and the Forgotten Land",
      nameZhSource: "legacy_pending_sync",
    });
  });

  it("stores manual Chinese only when the final official check is unavailable", async () => {
    // 管理员决策仍需在写入前重新核验官方来源；确认不可用后才接受含汉字且去除首尾空白的人工名称。
    const service = createSyncService({
      resolveOfficialName: async () => ({ kind: "unavailable" as const }),
    });

    await service.confirmDecisions([{ subscriptionId: "sub-kirby", nameZh: "  星之卡比 探索发现  " }], now);
    await expect(readKirbyGame()).resolves.toEqual({
      nameZh: "星之卡比 探索发现",
      nameZhSource: "manual_chinese",
    });
  });

  it("stores the official result instead of a manual decision when final verification succeeds", async () => {
    // 从同步预览到最终确认之间官方状态可能恢复；此时最新官方结果优先，不能把浏览器旧决策覆盖到可核验名称之上。
    const service = createSyncService({
      resolveOfficialName: async () => ({ kind: "hong_kong_official" as const, nameZh: "星之卡比 探索发现" }),
    });

    await service.confirmDecisions([{ subscriptionId: "sub-kirby", nameZh: "浏览器旧名称" }], now);
    await expect(readKirbyGame()).resolves.toEqual({
      nameZh: "星之卡比 探索发现",
      nameZhSource: "hong_kong_official",
    });
  });

  it("stores the official English fallback when the decision omits a Chinese name", async () => {
    // 缺失名称是管理员明确接受官方英文标题的决定；必须写入 name_en 锚点并标注英文回退，不能保存空串或迁移待同步来源。
    const service = createSyncService({
      resolveOfficialName: async () => ({ kind: "unavailable" as const }),
    });

    await service.confirmDecisions([{ subscriptionId: "sub-kirby" }], now);
    await expect(readKirbyGame()).resolves.toEqual({
      nameZh: "Kirby and the Forgotten Land",
      nameZhSource: "official_english_fallback",
    });
  });

  it("keeps a manual Chinese name during a later official sync", async () => {
    // manual_chinese 代表管理员已明确决定；普通后台同步必须直接返回待决策且不请求外部官方源，避免无人值守覆盖人工名称。
    const officialNames = {
      resolveOfficialName: vi.fn().mockResolvedValue({ kind: "mainland_official" as const, nameZh: "官方新名称" }),
    };
    const service = createSyncService(officialNames);
    await new GameNameRepository(env.DB).updateForSubscription("sub-kirby", "星之卡比 探索发现", "manual_chinese", now);

    await expect(service.sync(["sub-kirby"], now)).resolves.toEqual([
      { subscriptionId: "sub-kirby", status: "needs-decision", nameEn: "Kirby and the Forgotten Land" },
    ]);
    expect(officialNames.resolveOfficialName).not.toHaveBeenCalled();
    await expect(readKirbyGame()).resolves.toEqual({
      nameZh: "星之卡比 探索发现",
      nameZhSource: "manual_chinese",
    });
  });

  it.each([
    { label: "空数组", decisions: [] },
    {
      label: "重复订阅",
      decisions: [
        { subscriptionId: "sub-kirby", nameZh: "星之卡比" },
        { subscriptionId: "sub-kirby" },
      ],
    },
    { label: "未知订阅", decisions: [{ subscriptionId: "missing-subscription", nameZh: "未知游戏" }] },
  ])("rejects $label decisions with a controlled domain error", async ({ decisions }) => {
    // 批量决策必须先完整验证选择范围；空选择、重复写入或未知订阅都不能被静默忽略，更不能形成部分名称更新。
    const service = createSyncService({
      resolveOfficialName: async () => ({ kind: "unavailable" as const }),
    });

    await expect(service.confirmDecisions(decisions, now)).rejects.toBeInstanceOf(GameNameSyncError);
    await expect(readKirbyGame()).resolves.toEqual({
      nameZh: "Kirby and the Forgotten Land",
      nameZhSource: "legacy_pending_sync",
    });
  });

  it.each(["English Only", "オーバークック２", "游".repeat(201)])(
    "rejects an invalid manual Chinese decision before writing: %s",
    async (nameZh) => {
      // 人工名称必须包含汉字且按 Unicode 字符计不超过 200；纯英文、假名和超长内容都不能借来源字段污染后续页面与通知。
      const service = createSyncService({
        resolveOfficialName: async () => ({ kind: "unavailable" as const }),
      });

      await expect(service.confirmDecisions([{ subscriptionId: "sub-kirby", nameZh }], now))
        .rejects.toBeInstanceOf(GameNameSyncError);
      await expect(readKirbyGame()).resolves.toEqual({
        nameZh: "Kirby and the Forgotten Land",
        nameZhSource: "legacy_pending_sync",
      });
    },
  );
});

/** 名称服务替身只控制慢速外部解析；真实仓储负责读取锚点、香港 URL、英文标题及最终更新归属。 */
function createSyncService(officialNames: {
  resolveOfficialName(
    anchor: OfficialProductCandidate,
    knownHongKongUrl?: string,
  ): Promise<{ kind: "mainland_official" | "hong_kong_official"; nameZh: string } | { kind: "unavailable" }>;
}): GameNameSyncService {
  return new GameNameSyncService(new GameNameRepository(env.DB), officialNames);
}

/** 建立一条历史待同步游戏及其订阅拥有的 US/HK 映射；HK 标题 URL 是同步服务可传给名称解析器的唯一可信捷径。 */
async function seedKirbySubscription(now: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO games (id, name_zh, name_en, normalized_name, publisher, product_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("game-kirby", "Kirby and the Forgotten Land", "Kirby and the Forgotten Land", "kirby|nintendo|game", "Nintendo", "game", now),
    env.DB.prepare(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
    ).bind("kirby-us", "game-kirby", "US", "USD", "https://www.nintendo.com/us/store/products/kirby/", "manual_selection", "2026-07-26T07:59:59.000Z"),
    env.DB.prepare(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
    ).bind("kirby-hk", "game-kirby", "HK", "HKD", "https://ec.nintendo.com/HK/zh/titles/70010000000001", "manual_selection", now),
    env.DB.prepare(
      "INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    ).bind("sub-kirby", "game-kirby", now, now),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
      .bind("sub-kirby", "kirby-us"),
    env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)")
      .bind("sub-kirby", "kirby-hk"),
  ]);
}

/** 直接从 games 读取显示名与来源，验证同步结果真实落盘且没有只改变服务返回值。 */
async function readKirbyGame(): Promise<{ nameZh: string; nameZhSource: string } | null> {
  return env.DB.prepare("SELECT name_zh AS nameZh, name_zh_source AS nameZhSource FROM games WHERE id = ?")
    .bind("game-kirby")
    .first<{ nameZh: string; nameZhSource: string }>();
}
