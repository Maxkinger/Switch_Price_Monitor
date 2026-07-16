import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

import coreSchema from "../migrations/0001_core.sql?raw";
import priceTrackingSchema from "../migrations/0002_price_tracking.sql?raw";
import authSchema from "../migrations/0003_auth.sql?raw";

beforeAll(async () => {
  // Cloudflare 测试 D1 对整段多语句 exec 的兼容性有限；逐条 prepare/run 更接近生产迁移的原子语句执行方式。
  for (const statement of [...splitStatements(coreSchema), ...splitStatements(priceTrackingSchema), ...splitStatements(authSchema)]) {
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
