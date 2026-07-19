import { describe, expect, it } from "vitest";

import { displayChineseGameName, resolveChineseGameName } from "../src/shared/game-display-name";

/** 中文游戏名展示规则只测试受控本地词表，不接入翻译、AI 或第三方服务，避免商品身份被外部不可审计文本影响。 */
describe("中文游戏名展示", () => {
  it("resolves confirmed Overcooked 2 titles to Chinese display names", () => {
    // 这些标题来自任天堂不同地区的官方候选；只要商品仍是同一 Overcooked 2 系列，就应在管理页用中文游戏名展示。
    expect(resolveChineseGameName("Overcooked! 2")).toBe("胡闹厨房 2");
    expect(resolveChineseGameName("Overcooked! 2 – Nintendo Switch 2 Edition")).toBe("胡闹厨房 2 Nintendo Switch 2 Edition");
    expect(resolveChineseGameName("Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack")).toBe("胡闹厨房 2 Nintendo Switch 2 Edition 升级包");
    expect(resolveChineseGameName("Overcooked! 2 - Gourmet Edition")).toBe("胡闹厨房 2：美食家版");
  });

  it("keeps existing Chinese names and safely falls back for unknown titles", () => {
    // 已有中文名优先，未知游戏不得猜测翻译；这样不会把其它 Switch 商品错误显示为胡闹厨房。
    expect(displayChineseGameName("胡闹厨房 2：美食家版", "Overcooked! 2 - Gourmet Edition")).toBe("胡闹厨房 2：美食家版");
    expect(displayChineseGameName("Kirby and the Forgotten Land", "Kirby and the Forgotten Land")).toBe("Kirby and the Forgotten Land");
  });

  it("does not treat Japanese official titles with kanji as already Chinese", () => {
    // 日区官方标题可能包含汉字；它仍应先进入受控 Overcooked 词表，不能因为含有 `真の食通` 就直接显示日文标题。
    expect(displayChineseGameName("Overcooked® 2 - オーバークック２：真の食通エディション", "Overcooked! 2 - Gourmet Edition")).toBe("胡闹厨房 2：美食家版");
  });
});
