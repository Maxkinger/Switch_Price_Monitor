/**
 * 可持久化的游戏中文名称来源集合；来源必须与名称一同保存，以便界面、通知和迁移能够区分官方转换、人工确认、
 * 英文回退及历史待同步数据，避免把未经确认的显示文本误当作商品身份信息。
 */
export const gameNameSources = [
  /** 未来任务从腾讯大陆官方同 ID 商品确认的标题；它优先于香港转换结果，避免用繁简转换猜测大陆官方本地化名称。 */
  "mainland_official",
  /** 由香港任天堂官方标题经本地繁简词典转换，原始官方标题仍是商品身份依据。 */
  "hong_kong_official",
  /** 由管理员输入并经汉字校验的中文名，日文假名不可使用此来源绕过官方回退。 */
  "manual_chinese",
  /** 没有可确认中文名时展示官方英文标题，明确提示该值不是中文翻译。 */
  "official_english_fallback",
  /** 旧数据尚未补齐来源，迁移前必须保守展示并等待后续同步，不可猜测其语言或身份。 */
  "legacy_pending_sync",
] as const;

/**
 * 受限于 `gameNameSources` 的名称来源联合类型；通过从常量推导，新增来源时可强制所有写入路径显式评估其业务含义。
 */
export type GameNameSource = (typeof gameNameSources)[number];
