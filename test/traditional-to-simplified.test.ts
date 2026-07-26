import { describe, expect, it } from "vitest";

import { convertHongKongTraditionalToSimplified, hasChineseText } from "../src/shared/traditional-to-simplified";

/**
 * 香港官方标题的繁简转换和人工名称识别必须完全离线运行；测试直接调用真实实现，
 * 以防未来改动意外引入网络翻译、错误转换，或将日文假名当作可接受的人工中文名称。
 */
describe("香港官方游戏名繁简转换", () => {
  it("uses an offline Hong Kong Traditional-to-Simplified conversion", () => {
    // 此断言固定词典的字面繁简结果；大陆官方本地化用名由后续同 ID 官方标题来源处理，不能在此转换器中猜测。
    expect(convertHongKongTraditionalToSimplified("薩爾達傳說 王國之淚")).toBe("萨尔达传说 王国之泪");
  });

  it("does not mistake Japanese kana for a Chinese manual name", () => {
    // 日文假名不属于汉字，不能绕过官方名称回退；真实中文名称含汉字时才允许作为人工中文输入。
    expect(hasChineseText("オーバークック２")).toBe(false);
    expect(hasChineseText("胡闹厨房 2")).toBe(true);
  });
});
