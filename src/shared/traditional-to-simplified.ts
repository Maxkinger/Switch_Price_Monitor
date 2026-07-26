import OpenCC from "opencc-js";

/**
 * 香港官方标题仅在 Worker 内存中以内置词典转换为简体，禁止把商品标题发送给翻译服务；
 * `hk` 到 `cn` 的固定方向保留香港常用词语的语义，避免通用转换造成订阅商品名称不可追溯。
 */
const hongKongToSimplified = OpenCC.Converter({ from: "hk", to: "cn" });

/**
 * 将香港任天堂官方繁体标题转换为简体展示名；空结果不能回退为猜测名称，
 * 调用方必须显式处理异常并保留原始官方身份字段，防止错误文本污染订阅和通知。
 */
export function convertHongKongTraditionalToSimplified(title: string): string {
  const converted = hongKongToSimplified(title).trim();
  if (!converted) throw new Error("香港官方标题转换结果为空。");
  return converted;
}

/**
 * 只有包含汉字的值才构成可接受的人工中文名；日文假名单独出现时必须返回 false，
 * 使路由继续采用官方名称回退规则，而不是把日区标题误标为管理员确认的中文名称。
 */
export function hasChineseText(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}
