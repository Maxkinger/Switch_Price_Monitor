import { describe, expect, it } from "vitest";

import { dashboardPath, gameNameManagementPath, readAppRoute, settingsPath, subscriptionDetailPath } from "../src/app/app-navigation";

/** 路由纯函数测试确保浏览器前进/返回只解释本站已实现的仪表盘、订阅、名称管理和设置页面，未知路径安全回到仪表盘。 */
describe("app navigation", () => {
  it("maps a subscription URL and creates stable dashboard and detail paths", () => {
    // 订阅 ID 可能含 URL 编码字符；读取时必须解码，生成时必须编码，避免地址栏内容被误切分为额外路径。
    expect(readAppRoute("/subscriptions/subscription-overcooked-2")).toEqual({ kind: "subscription-detail", subscriptionId: "subscription-overcooked-2" });
    expect(readAppRoute("/subscriptions/game%2Fsafe")).toEqual({ kind: "subscription-detail", subscriptionId: "game/safe" });
    expect(dashboardPath()).toBe("/");
    expect(subscriptionDetailPath("game/safe")).toBe("/subscriptions/game%2Fsafe");
  });

  it("routes the add page explicitly and does not render unknown paths as blank pages", () => {
    // 未实现页面不能伪装成空白成功页；统一回到仪表盘可保留应用的已登录安全壳层。
    expect(readAppRoute("/subscriptions/new")).toEqual({ kind: "subscription-new" });
    expect(readAppRoute("/not-implemented")).toEqual({ kind: "dashboard" });
  });

  it("maps the settings URL and keeps nested settings paths on the dashboard", () => {
    // 设置只允许单一公开偏好页；未来 Telegram 等子路径未设计前必须回退，不能误展示空白或秘密配置页。
    expect(readAppRoute("/settings")).toEqual({ kind: "settings" });
    expect(settingsPath()).toBe("/settings");
    expect(readAppRoute("/settings/telegram")).toEqual({ kind: "dashboard" });
  });

  it("maps the exact game-name management URL and rejects nested management paths", () => {
    // 名称管理是单独的受认证页面；只接受固定路径，避免把游戏 ID 或官方标题误塞进浏览器地址。
    expect(gameNameManagementPath()).toBe("/game-names");
    expect(readAppRoute("/game-names")).toEqual({ kind: "game-names" });
    expect(readAppRoute("/game-names/game-kirby")).toEqual({ kind: "dashboard" });
  });
});
