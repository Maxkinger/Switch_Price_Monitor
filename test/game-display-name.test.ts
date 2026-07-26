import { describe, expect, it } from "vitest";

import { displayChineseGameName } from "../src/shared/game-display-name";

/**
 * 游戏名展示必须消费已经确定的名称来源，而非根据标题猜测或翻译；测试直接调用展示函数，
 * 防止旧词表覆盖大陆、香港或人工保存的官方名称，并防止英文回退在展示阶段被悄然改写。
 */
describe("中文游戏名展示", () => {
  it("preserves non-empty stored mainland and Hong Kong official names without title rewriting", () => {
    // 两个值均已在名称来源层确认；即使其内容命中旧 Overcooked 词表，展示层也不得覆盖大陆或香港官方保存结果。
    expect(displayChineseGameName("Overcooked! 2 - Gourmet Edition", "unused English fallback")).toBe("Overcooked! 2 - Gourmet Edition");
    expect(displayChineseGameName("Overcooked® 2 - オーバークック２：真の食通エディション", "unused English fallback")).toBe("Overcooked® 2 - オーバークック２：真の食通エディション");
    // 已保存的简体官方标题必须原样通过；这条回归防止后续展示逻辑重新引入旧词表并改写新的大陆或香港来源。
    expect(displayChineseGameName("塞尔达传说 王国之泪", "The Legend of Zelda: Tears of the Kingdom")).toBe("塞尔达传说 王国之泪");
  });

  it("uses the English fallback unchanged only when no stored Chinese name exists", () => {
    // 空白 `nameZh` 表示尚无已确认中文名；英文回退保留原貌，不能由展示函数猜测为另一种中文标题。
    expect(displayChineseGameName("   ", "Overcooked! 2 - Gourmet Edition")).toBe("Overcooked! 2 - Gourmet Edition");
    // 英文回退同样会保存到 `nameZh`；展示层不可把该明确管理员选择再次转换或替换为猜测的中文名。
    expect(displayChineseGameName("Kirby and the Forgotten Land", "Kirby and the Forgotten Land")).toBe("Kirby and the Forgotten Land");
  });
});
