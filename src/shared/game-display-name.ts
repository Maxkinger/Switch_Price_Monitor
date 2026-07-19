/**
 * 受控中文游戏名词表。这里不是通用翻译器，只保存已经在需求和测试中确认过的游戏系列与版本标记；
 * 未命中时必须回退官方标题，避免把其它任天堂商品误翻译成错误中文名，进而误导订阅、日报或详情页阅读。
 */
export function resolveChineseGameName(officialTitle: string): string | null {
  const normalized = normalizeOfficialTitle(officialTitle);
  if (!/\bovercooked!?\s*2\b/u.test(normalized)) return null;

  const hasSwitch2Edition = /\bnintendo\s+switch\s*2\s+edition\b/u.test(normalized);
  const isUpgradePack = /\bupgrade\s+pack\b/u.test(normalized) || normalized.includes("アップグレードパス");
  const isGourmetEdition = /\bgourmet\s+edition\b/u.test(normalized) || normalized.includes("真の食通") || normalized.includes("美食家");

  if (isGourmetEdition) return "胡闹厨房 2：美食家版";
  if (hasSwitch2Edition && isUpgradePack) return "胡闹厨房 2 Nintendo Switch 2 Edition 升级包";
  if (hasSwitch2Edition) return "胡闹厨房 2 Nintendo Switch 2 Edition";
  return "胡闹厨房 2";
}

/**
 * 页面展示优先使用已经人工确认或后端生成的中文名；如果历史数据把英文官方标题写进了 `nameZh`，
 * 再用官方英文标题兜底解析。未知游戏保持原始展示名，保证新增词表前不会出现未经确认的自动翻译。
 */
export function displayChineseGameName(nameZh: string, nameEn: string): string {
  const trimmedNameZh = nameZh.trim();
  const resolvedName = resolveChineseGameName(trimmedNameZh) ?? resolveChineseGameName(nameEn);
  if (resolvedName) return resolvedName;
  if (containsChineseText(trimmedNameZh)) return trimmedNameZh;
  return trimmedNameZh || nameEn.trim();
}

/** 官方标题在不同地区会混用破折号、注册商标、全角数字和日文说明；标准化只服务于词表命中，不改变持久化官方标题。 */
function normalizeOfficialTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[®™℠]/gu, "")
    .replace(/[–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

/** 只把含汉字的字符串视为已有中文名；日文假名官方标题仍会进入受控词表，避免被误当中文名直接展示。 */
function containsChineseText(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}
