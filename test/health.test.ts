import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";

describe("GET /api/health", () => {
  it("returns a stable health payload", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/api/health"),
      {} as Env,
      {} as ExecutionContext,
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "switch-price-monitor",
    });
  });
});
