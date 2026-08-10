import type { OfficialProductCandidate } from "./domain";

/**
 * 为同一官方游戏生成可持久化的精确身份键。
 * 标题、发行商（可空时保留空段）和商品类型的顺序必须与既有 games.normalized_name 完全一致，
 * 这样目录只会命中经官方确认的同一商品，不会因为相似标题把 DLC、本体或不同发行商作品误译为同名游戏。
 * 简体中文展示名称绝不能传入本函数；它是可审计的本地展示数据，不是任天堂商品身份的一部分。
 */
export function gameNameIdentityKey(
  candidate: Pick<OfficialProductCandidate, "canonicalTitle" | "publisher" | "productType">,
): string {
  return [
    normalizeOfficialIdentityPart(candidate.canonicalTitle),
    candidate.publisher === null ? "" : normalizeOfficialIdentityPart(candidate.publisher),
    candidate.productType,
  ].join("|");
}

/**
 * 官方身份片段只折叠首尾与连续空白并作 Unicode 小写化，不翻译、不删标点也不猜测别名。
 * 保持这一保守规则可让新旧订阅的唯一键稳定，同时避免把不同官方标题意外合并。
 */
function normalizeOfficialIdentityPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
