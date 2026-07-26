import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { GameNameRepository } from "../src/worker/repositories/game-name-repository";

/**
 * 名称仓储直接使用测试 D1，覆盖迁移默认值、订阅归属与只读锚点三条持久化边界；
 * 不使用 mock，以免伪造的返回值掩盖 SQL 联表或外键约束错误而让越权改名进入生产。
 */
describe("GameNameRepository", () => {
  const repository = new GameNameRepository(env.DB);
  const now = "2026-07-26T08:00:00.000Z";

  beforeEach(async () => {
    // 按外键反向顺序清理订阅关联、订阅、地区商品和游戏，保证每个用例都独立验证迁移默认值与归属限制。
    await env.DB.exec("DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games;");
    await env.DB.batch([
      // 该历史游戏故意未提供新列，验证 0007 必须保留既有展示文本并由数据库默认值标记待同步，而不是迁移时猜测中文名。
      env.DB.prepare("INSERT INTO games (id, name_zh, name_en, normalized_name, product_type, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind("legacy-game", "Kirby and the Forgotten Land", "Kirby and the Forgotten Land", "kirby|nintendo|game", "game", now),
      env.DB.prepare("INSERT INTO games (id, name_zh, name_en, normalized_name, product_type, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind("other-game", "Other Game", "Other Game", "other|nintendo|game", "game", now),
      // 两个地区商品都属于历史游戏；US 排在前面作为只读身份锚点，HK 则必须被单独保留为后续同 ID 官方名称核验的可信 URL。
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind("legacy-us", "legacy-game", "US", "USD", "https://www.nintendo.com/us/store/products/kirby/", "manual_selection", "2026-07-26T07:59:59.000Z"),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind("legacy-hk", "legacy-game", "HK", "HKD", "https://ec.nintendo.com/HK/zh/titles/70010000000001", "manual_selection", now),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind("other-us", "other-game", "US", "USD", "https://www.nintendo.com/us/store/products/other/", "manual_selection", now),
      env.DB.prepare("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
        .bind("legacy-subscription", "legacy-game", now, now),
      env.DB.prepare("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
        .bind("other-subscription", "other-game", now, now),
      env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind("legacy-subscription", "legacy-us"),
      env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind("legacy-subscription", "legacy-hk"),
      env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind("other-subscription", "other-us"),
    ]);
  });

  it("marks existing games as pending without changing their stored display name", async () => {
    // 旧数据上线时不访问任天堂；原英文显示名必须原样保留，以免一次网络失败或错误匹配改写管理员当前看到的游戏名称。
    const row = await env.DB.prepare("SELECT name_zh AS nameZh, name_zh_source AS source FROM games WHERE id = ?")
      .bind("legacy-game").first<{ nameZh: string; source: string }>();
    expect(row).toEqual({ nameZh: "Kirby and the Forgotten Land", source: "legacy_pending_sync" });
  });

  it("does not update a game when the selected subscription does not own it", async () => {
    // 更新仅能经 subscription_id 子查询定位其所属 game；不存在或不匹配的订阅不得产生跨订阅写入，也不应把零影响伪装成成功。
    await expect(repository.updateForSubscription("missing-subscription", "星之卡比 探索发现", "manual_chinese", now)).resolves.toBe(false);
    const row = await env.DB.prepare("SELECT name_zh AS nameZh, name_zh_source AS source FROM games WHERE id = ?")
      .bind("legacy-game").first<{ nameZh: string; source: string }>();
    expect(row).toEqual({ nameZh: "Kirby and the Forgotten Land", source: "legacy_pending_sync" });
  });

  it("updates only the game owned by an authorized subscription and persists its name source", async () => {
    // 真实 D1 更新必须同时落盘展示名和来源；并读取另一订阅的游戏，证明子查询没有因名称或来源参数把更新扩大到未选订阅。
    await expect(repository.updateForSubscription("legacy-subscription", "星之卡比 探索发现", "manual_chinese", now)).resolves.toBe(true);
    const [updated, untouched] = await env.DB.batch([
      env.DB.prepare("SELECT name_zh AS nameZh, name_zh_source AS source FROM games WHERE id = ?").bind("legacy-game"),
      env.DB.prepare("SELECT name_zh AS nameZh, name_zh_source AS source FROM games WHERE id = ?").bind("other-game"),
    ]);
    // 所选订阅归属的游戏获得人工中文来源，保证后续自动同步能够识别并保护管理员明确输入的名称。
    expect(updated.results[0]).toEqual({ nameZh: "星之卡比 探索发现", source: "manual_chinese" });
    // 另一个订阅仍保留迁移默认状态，避免任意已知 subscription ID 被用来间接改写不在本次选择范围内的游戏。
    expect(untouched.results[0]).toEqual({ nameZh: "Other Game", source: "legacy_pending_sync" });
  });

  it("rebuilds a subscription-owned anchor and its monitored Hong Kong URL for later sync", async () => {
    // 同步服务只能消费 D1 重建的官方锚点与已监控 HK URL，不能接受浏览器提供的标题、地区或链接来决定后续自动改名。
    await expect(repository.findForSync(["legacy-subscription"])).resolves.toEqual([
      expect.objectContaining({
        subscriptionId: "legacy-subscription",
        gameId: "legacy-game",
        source: "legacy_pending_sync",
        nameEn: "Kirby and the Forgotten Land",
        hongKongProductUrl: "https://ec.nintendo.com/HK/zh/titles/70010000000001",
        anchor: expect.objectContaining({ regionCode: "US", productUrl: "https://www.nintendo.com/us/store/products/kirby/" }),
      }),
    ]);
  });
});
