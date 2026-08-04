import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SubscriptionRepository } from "../src/repositories/subscription-repository";

describe("D1 SubscriptionRepository concurrent create compatibility", () => {
  beforeEach(async () => {
    // 订阅创建依赖游戏和地区商品；按外键反向清空 D1 测试数据，确保获胜请求只来自本例而不会把历史夹具误判为并发结果。
    await env.DB.exec("DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games;");
  });

  it("returns the winning subscription instead of leaking a unique-game race as a 500", async () => {
    // 在本请求第一次只读查重后同步注入另一请求的获胜写入；本请求自己的唯一 game_id INSERT 随后失败，兼容仓储必须重读并稳定返回 existing。
    await env.DB.prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)")
      .bind("game-d1-race", "并发游戏", "D1 Race Game", "game")
      .run();
    await env.DB.prepare(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("product-d1-race", "game-d1-race", "US", "USD", "https://example.test/us/d1-race", "manual_selection").run();
    const repository = new SubscriptionRepository(env.DB);
    const create = repository.create.bind(repository);
    let injectedWinner = false;
    repository.create = async (input) => {
      if (!injectedWinner) {
        injectedWinner = true;
        await create({
          id: "subscription-d1-winner",
          gameId: "game-d1-race",
          regionalProductIds: ["product-d1-race"],
          createdAt: "2026-08-04T02:30:00.000Z",
        });
      }
      await create(input);
    };

    await expect(repository.createOrOpenAtomically({
      id: "subscription-d1-loser",
      gameId: "game-d1-race",
      regionalProductIds: ["product-d1-race"],
      createdAt: "2026-08-04T02:30:01.000Z",
    })).resolves.toEqual({ status: "existing", subscriptionId: "subscription-d1-winner" });
  });
});
