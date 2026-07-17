import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/worker";

describe("GET /api/health", () => {
  it("returns a stable health payload", async () => {
    // 健康检查不应依赖 D1 或静态资源，部署平台可用它区分 Worker 路由故障与业务数据尚未初始化。
    const response = await worker.fetch!(
      new Request("https://example.test/api/health") as never,
      {} as Env,
      {} as ExecutionContext,
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "switch-price-monitor",
    });
  });
});
