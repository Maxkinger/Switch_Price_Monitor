import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

import coreSchema from "../migrations/0001_core.sql?raw";
import priceTrackingSchema from "../migrations/0002_price_tracking.sql?raw";

beforeAll(async () => {
  for (const statement of [...splitStatements(coreSchema), ...splitStatements(priceTrackingSchema)]) {
    await env.DB.prepare(statement).run();
  }
});

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
