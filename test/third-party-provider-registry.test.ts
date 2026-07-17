import { describe, expect, it } from "vitest";

import { createThirdPartyProviderRegistry } from "../src/worker/providers/third-party-provider-registry";

describe("第三方价格提供方注册表", () => {
  it("对未获准的站点不创建提供方且明确返回不可用来源", () => {
    // 本测试刻意只检查公开的注册表契约：没有获得 API 或书面许可的站点，
    // 不得产生可被 ProviderChain 执行的提供方，避免后台在用户不知情时访问第三方网页。
    const registry = createThirdPartyProviderRegistry();

    // eShop Prices 与 NT Deals 是用户可在设置中选择的候选来源；当前阶段只记录
    // 它们不可用，而非伪造“查询失败”的价格结果或启动任何网络请求。
    expect(registry.providersFor(["eshop-prices", "nt-deals"])).toEqual([]);
    expect(registry.unavailableSources).toEqual(["eshop-prices", "nt-deals"]);
  });
});
