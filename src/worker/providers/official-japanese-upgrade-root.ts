import type { OfficialProductCandidate } from "../../shared/domain";

/** 日区升级包唯一对应的可购买本体；只携带后续 Browser 关系验证所需的官方 URL 与瞬时身份字段。 */
export interface JapaneseUpgradeRootCandidate {
  productUrl: string;
  canonicalTitle: string;
  publisher: string;
}

/**
 * 日区升级根商品的最小可注入检索契约。调用者必须提供取消信号，避免外部公开搜索在 Worker 请求结束后继续占用资源。
 */
export interface JapaneseUpgradeRootSearch {
  search(anchor: OfficialProductCandidate, signal: AbortSignal): Promise<JapaneseUpgradeRootCandidate | null>;
}

/** 该 API 是任天堂日区公开软件索引；固定端点避免把升级包标题或任何调用方输入变成任意站点请求。 */
const officialJapaneseSearchEndpoint = "https://search.nintendo.jp/nintendo_soft/search.json";

/** My Nintendo Store 下载版 URL 只能由已经校验的纯数字 NSUID 导出，D 前缀是商城受控路径的一部分。 */
const officialJapaneseStoreSoftwarePrefix = "https://store-jp.nintendo.com/item/software/D";

/**
 * 创建只读的日区升级本体查找器。它不使用 Browser Run、D1 或第三方站点；只有唯一同时满足下载版、升级标记与跨语言身份的官方项目才返回。
 * 多条完整命中故意返回 null，而不是按 API 顺序选择，防止同发行商同系列的不同版本被自动保存为错误关系。
 */
export function createOfficialJapaneseUpgradeRootSearch(fetchSearch: typeof fetch = fetch): JapaneseUpgradeRootSearch {
  return {
    async search(anchor, signal) {
      if (anchor.productType !== "upgrade-pack" || anchor.publisher === null) return null;
      const query = readUpgradeBaseTitle(anchor.canonicalTitle);
      if (query === null) return null;

      const url = new URL(officialJapaneseSearchEndpoint);
      url.search = new URLSearchParams({ q: query, limit: "20", page: "1", opt_search: "1" }).toString();
      let response: Response;
      try {
        response = await fetchSearch(url, { headers: { accept: "application/json" }, signal });
      } catch {
        // 网络、取消或公开服务临时拒绝都不能泄露上游错误文本，更不能沿用旧候选；没有本次官方证据时必须安全降级。
        return null;
      }
      if (!response.ok) return null;

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // 官网偶发 HTML 错页或截断 JSON 时不能把异常传播成候选；本次缺乏可审计根商品证据，应安全交给人工链接流程。
        return null;
      }
      const roots = parseRoots(payload).filter((root) => hasMatchingRootIdentity(anchor, root));
      return roots.length === 1 ? roots[0] : null;
    },
  };
}

/**
 * 从升级包标题读出稳定的本体检索词。仅移除已审核的末尾 Nintendo Switch 2 Edition / Upgrade Pack 版本后缀，
 * 防止营销文案或标题中间的相近词被截断后误触发跨区自动关联；剩余内容还必须提供完整的游戏系列证据。
 */
function readUpgradeBaseTitle(title: string): string | null {
  const baseTitle = removeApprovedVersionSuffix(title);
  return baseTitle && latinSeriesMarker(baseTitle) !== null ? baseTitle : null;
}

/**
 * 将公开 API 响应收窄为可导出日区商城链接的下载版升级根商品。所有字段来自外部 JSON，故每条记录必须独立校验；
 * 缺失、类型错误或不支持的商城形态都只丢弃该记录，不能以部分字段猜测 URL 或发行商。
 */
function parseRoots(payload: unknown): JapaneseUpgradeRootCandidate[] {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.items)) return [];
  return payload.result.items.flatMap((item) => {
    const root = toRootCandidate(item);
    return root === null ? [] : [root];
  });
}

/**
 * 只接受日区公开索引中的数字下载软件升级项。`id === nsuid` 阻止实体版或派生编号被拼入商城 URL，
 * `BEE_DL`/`HAC_DL` 与严格的 `upgrade === 1` 则确保这是可购买的 Switch 2 Edition 升级根，而非卡带、DLC 或普通搜索命中。
 */
function toRootCandidate(value: unknown): JapaneseUpgradeRootCandidate | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const nsuid = value.nsuid;
  const title = readNonEmptyString(value.title);
  const publisher = readNonEmptyString(value.maker);
  if (typeof id !== "string" || id !== nsuid || !/^\d+$/.test(id)
    || (value.sform !== "BEE_DL" && value.sform !== "HAC_DL")
    || value.upgrade !== 1
    || title === null
    || publisher === null
    || !/nintendo\s+switch\s*2\s+edition/iu.test(title)) return null;
  return {
    productUrl: `${officialJapaneseStoreSoftwarePrefix}${id}/`,
    canonicalTitle: title,
    publisher,
  };
}

/**
 * 对本地化日区根商品执行完整跨语言身份约束。发行商比较会统一 NFKC、大小写、商标符号与空白；
 * 标题只比较第一个拉丁系列片段，以容纳日文别名，但发行商或系列任一不一致时绝不自动关联。
 */
function hasMatchingRootIdentity(anchor: OfficialProductCandidate, root: JapaneseUpgradeRootCandidate): boolean {
  return normalizePublisher(anchor.publisher ?? "") === normalizePublisher(root.publisher)
    && latinSeriesMarker(anchor.canonicalTitle) !== null
    && latinSeriesMarker(anchor.canonicalTitle) === latinSeriesMarker(root.canonicalTitle);
}

/**
 * 发行商文本只为身份比较而规范化，不修改展示或持久化的官方名称。保留普通标点而只去掉商标符号，
 * 并用与运行地区无关的 Unicode 小写规则，避免不同 Worker locale 把相同发行商判成不同身份。
 */
function normalizePublisher(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[®™℠]/gu, "").trim().replace(/\s+/gu, " ");
}

/**
 * 提取完整的前导拉丁/数字游戏标题：先统一 NFKC、大小写和商标符号，移除已审核的末尾版本后缀，
 * 再在首个非拉丁字母处截断，最后才删除排版符号。这个顺序保留 `Super Mario Bros. 2`、`NBA 2K25` 和 `F1 25` 的完整差异，
 * 同时使日文别名后的版本词不能混入游戏身份；空串、无编号或 Nintendo/Switch 泛化标记一律不能触发自动关联。
 */
function latinSeriesMarker(title: string): string | null {
  const normalized = removeApprovedVersionSuffix(title).normalize("NFKC").toLowerCase().replace(/[®™℠]/gu, "");
  const marker = readLeadingLatinPhrase(normalized).replace(/[^a-z0-9]+/gu, "");
  if (!/[a-z]/u.test(marker) || !/\d/u.test(marker) || genericLatinMarkers.has(marker)) return null;
  return marker;
}

/** 已审核的版本后缀只允许在标题末尾消失；此函数绝不翻译、猜测或删除游戏名中间的版本词。 */
function removeApprovedVersionSuffix(title: string): string {
  return title.replace(/\s*[–—-]?\s*nintendo\s+switch\s*2\s+edition(?:\s+upgrade\s+pack)?\s*$/iu, "").trim();
}

/**
 * 日区标题通常以 ASCII/拉丁主标题开头、再接日文别名。遇到任一非拉丁字母即停止，
 * 使完整前缀在标点归一化之前保持原有单词和版本编号；纯英文标题则保留到已移除的受控后缀为止。
 */
function readLeadingLatinPhrase(title: string): string {
  for (let index = 0; index < title.length; index += 1) {
    const character = title[index];
    if (/\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character)) return title.slice(0, index).trim();
  }
  return title.trim();
}

/** 硬件与平台名不能代替游戏系列；该集合只包含被审核为无独立游戏身份的规范化标记。 */
const genericLatinMarkers = new Set(["nintendo", "switch", "switch2", "nintendoswitch", "nintendoswitch2", "nintendoswitch2edition"]);

/** 外部 JSON 仅允许普通对象进入字段读取，数组、null 和原始值都不能绕过身份约束。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 标题和发行商必须是去除首尾空白后仍有内容的字符串，防止对象或空白值在模板字符串中伪造官方身份。 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
