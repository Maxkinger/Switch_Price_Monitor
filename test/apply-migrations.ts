import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

import coreSchema from "../migrations/0001_core.sql?raw";
import priceTrackingSchema from "../migrations/0002_price_tracking.sql?raw";
import authSchema from "../migrations/0003_auth.sql?raw";
import manualRefreshSchema from "../migrations/0004_manual_refresh.sql?raw";
import subscriptionConfirmationSchema from "../migrations/0005_subscription_confirmation.sql?raw";
import immediateManualRefreshSchema from "../migrations/0006_immediate_manual_refresh.sql?raw";

beforeAll(async () => {
  // Cloudflare 测试 D1 对整段多语句 exec 的兼容性有限；逐条 prepare/run 更接近生产迁移的原子语句执行方式。
  // 测试必须按生产编号顺序执行所有迁移；0006 会重建旧刷新队列表以取消待执行记录，遗漏它会让测试错误地依赖 Cron 队列状态。
  for (const statement of [...splitStatements(coreSchema), ...splitStatements(priceTrackingSchema), ...splitStatements(authSchema), ...splitStatements(manualRefreshSchema), ...splitStatements(subscriptionConfirmationSchema), ...splitStatements(immediateManualRefreshSchema)]) {
    await env.DB.prepare(statement).run();
  }
});

/**
 * 当前迁移不包含存储过程或字符串内分号，因此按语句结尾切分是安全的。
 * 若以后引入这类 SQL，必须替换为正式迁移解析器，不能静默错误拆分。
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
