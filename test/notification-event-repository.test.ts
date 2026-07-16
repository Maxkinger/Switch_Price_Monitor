import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { NotificationEventRepository } from "../src/worker/repositories/notification-event-repository";

describe("NotificationEventRepository", () => {
  beforeEach(async () => {
    // 通知事件引用地区商品；清理并重建最小外键夹具，让测试能验证唯一键而不依赖 Telegram 或外部网络。
    await env.DB.exec("DELETE FROM notification_events; DELETE FROM regional_products; DELETE FROM games;");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)").bind("game-notification", "通知测试游戏", "Notification Test Game", "game"),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)").bind("product-notification", "game-notification", "US", "USD", "https://example.test/us", "manual-link"),
    ]);
  });

  it("reserves a notification event only once for the same dedupe key", async () => {
    // 同一第三次失败可能因 Cron 重试被两次处理；唯一键必须让首次调用取得发送资格，后续调用只得到 false 且不新增事件。
    const events = new NotificationEventRepository(env.DB);
    const input = { regionalProductId: "product-notification", eventType: "collection-failure" as const, dedupeKey: "product-notification:failure:2026-07-16T12:00:00.000Z", createdAt: "2026-07-16T12:00:00.000Z" };

    await expect(events.reserve(input)).resolves.toBe(true);
    await expect(events.reserve(input)).resolves.toBe(false);
    await expect(env.DB.prepare("SELECT event_type AS eventType, status FROM notification_events").all<{ eventType: string; status: string }>()).resolves.toMatchObject({ results: [{ eventType: "collection-failure", status: "pending" }] });
  });
});
