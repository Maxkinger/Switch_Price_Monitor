import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NotificationEventRepository } from "../src/repositories/postgres/notification-event-repository";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("NotificationEventRepository", () => {
  // 通知仓储使用真实唯一键和 LEFT JOIN，测试不调用 Telegram 网络，也不保存任何 Token、Chat ID 或响应正文。
  const database = createTestDatabase();
  const events = new NotificationEventRepository(database);

  beforeAll(async () => {
    // schema 重建只允许固定回环 disposable 目标；正式迁移提供 dedupe 唯一键及关联删除 SET NULL 规则。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 通知测试完成后关闭池，避免 pending 查询连接残留到下一测试文件。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 只清理 disposable schema；重置 identity 让同一创建时间的 pending 事件按插入顺序稳定返回。
    await database.query("TRUNCATE games, regional_products, notification_events RESTART IDENTITY CASCADE");
    await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["game-notification", "通知测试游戏", "Notification Test Game", "game"]);
    await database.query(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)",
      ["product-notification", "game-notification", "US", "USD", "https://example.test/us", "manual-link"],
    );
  });

  it("reserves a notification event only once for the same dedupe key", async () => {
    // 同一第三次失败可能因 Cron 重试被两次处理；唯一键必须让首次调用取得发送资格，后续调用只得到 false 且不新增事件。
    const input = { regionalProductId: "product-notification", eventType: "collection-failure" as const, dedupeKey: "product-notification:failure:2026-07-16T12:00:00.000Z", createdAt: "2026-07-16T12:00:00.000Z" };

    await expect(events.reserve(input)).resolves.toBe(true);
    await expect(events.reserve(input)).resolves.toBe(false);
    const stored = await database.query<{ eventType: string; status: string }>(`SELECT event_type AS "eventType", status FROM notification_events`);
    expect(stored.rows).toEqual([{ eventType: "collection-failure", status: "pending" }]);
  });

  it("records only the successful delivery timestamp without storing Telegram response data", async () => {
    // 投递审计只需要安全状态和 Worker 时间；不保存响应正文可避免第三方错误内容意外带入数据库或导出文件。
    const input = { regionalProductId: "product-notification", eventType: "collection-recovered" as const, dedupeKey: "product-notification:recovered:2026-07-16T18:00:00.000Z", createdAt: "2026-07-16T18:00:00.000Z" };
    await events.reserve(input);

    await expect(events.markDelivered(input.dedupeKey, "2026-07-16T18:00:01.000Z")).resolves.toBe(true);
    const stored = await database.query<{ status: string; sentAt: Date | null }>(`SELECT status, sent_at AS "sentAt" FROM notification_events WHERE dedupe_key = $1`, [input.dedupeKey]);
    expect(stored.rows[0]?.status).toBe("delivered");
    expect(stored.rows[0]?.sentAt?.toISOString()).toBe("2026-07-16T18:00:01.000Z");
  });

  it("returns only pending events with game and region labels in creation order for the delivery scheduler", async () => {
    // 已投递事件绝不能再次进入发送队列；发送文本需要安全的游戏名和区域标签，绝不把内部商品 ID 或 Telegram 配置交给消息格式化层。
    const delivered = { regionalProductId: "product-notification", eventType: "collection-failure" as const, dedupeKey: "delivered", createdAt: "2026-07-16T12:00:00.000Z" };
    const pending = { regionalProductId: "product-notification", eventType: "collection-recovered" as const, dedupeKey: "pending", createdAt: "2026-07-16T18:00:00.000Z" };
    await events.reserve(delivered);
    await events.reserve(pending);
    await events.markDelivered(delivered.dedupeKey, "2026-07-16T12:00:01.000Z");

    await expect(events.pending()).resolves.toEqual([{ regionalProductId: "product-notification", eventType: "collection-recovered", dedupeKey: "pending", createdAt: "2026-07-16T18:00:00.000Z", gameNameZh: "通知测试游戏", regionCode: "US" }]);
  });

  it("orders pending events by identity when their creation timestamps are equal", async () => {
    // 同一 Cron 批次可为多个状态变迁写入完全相同的服务器时间；created_at 相等时必须再按 BIGINT 主键排序，避免 PostgreSQL 返回非确定顺序导致发送队列重放次序漂移。
    const createdAt = "2026-07-16T18:00:00.000Z";
    await events.reserve({ regionalProductId: "product-notification", eventType: "collection-failure", dedupeKey: "same-time-first", createdAt });
    await events.reserve({ regionalProductId: "product-notification", eventType: "collection-recovered", dedupeKey: "same-time-second", createdAt });

    const pendingEvents = await events.pending();
    expect(pendingEvents.map((event) => event.dedupeKey)).toEqual(["same-time-first", "same-time-second"]);
    expect(pendingEvents.map((event) => event.createdAt)).toEqual([createdAt, createdAt]);
  });

  it("returns nullable labels after the referenced product and game are deleted", async () => {
    // 审计事件通过 ON DELETE SET NULL 保留；关联主档删除后发送器只能收到空标签并使用中性文案，不能回退暴露内部商品 ID。
    await events.reserve({ regionalProductId: "product-notification", eventType: "collection-failure", dedupeKey: "orphaned", createdAt: "2026-07-16T12:00:00.000Z" });
    await database.query("DELETE FROM regional_products WHERE id = $1", ["product-notification"]);
    await database.query("DELETE FROM games WHERE id = $1", ["game-notification"]);

    await expect(events.pending()).resolves.toEqual([{ regionalProductId: null, eventType: "collection-failure", dedupeKey: "orphaned", createdAt: "2026-07-16T12:00:00.000Z", gameNameZh: null, regionCode: null }]);
  });

  it("does not hide foreign-key failures behind the dedupe conflict rule", async () => {
    // ON CONFLICT 必须只针对 dedupe_key；不存在商品的外键错误代表业务污染，不能像重复事件一样静默返回 false。
    await expect(events.reserve({ regionalProductId: "missing-product", eventType: "collection-failure", dedupeKey: "invalid-product", createdAt: "2026-07-16T12:00:00.000Z" })).rejects.toThrow();
  });
});
