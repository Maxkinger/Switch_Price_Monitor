import { describe, expect, it } from "vitest";

import { displayGameName } from "../src/shared/game-display-name";

/**
 * 页面中文名只信任服务端确认后的字段，不接入翻译、AI 或本地标题词表。
 * 这样尚未审核的英文、日文官方标题不会被前端猜测成中文，避免管理员将错误名称当作已确认数据。
 */
describe("中文游戏名展示", () => {
  it("uses the confirmed server display name without title inference", () => {
    // 该值已经由服务端目录或人工流程确认；前端必须原样呈现，不能因历史 Overcooked 规则改变名称。
    expect(displayGameName("胡闹厨房 2")).toBe("胡闹厨房 2");
  });

  it("uses a fixed placeholder only when the server has no confirmed Chinese name", () => {
    // null 表示待管理流程补充，固定文案让仪表盘与详情页不会把官方外文标题误当成中文游戏名。
    expect(displayGameName(null)).toBe("待补充中文名称");
  });
});
