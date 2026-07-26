/**
 * 展示层只读取名称来源层已保存的结果，不根据标题词表重新翻译、归类或规范化游戏名；
 * 这样大陆官方、香港官方及人工确认的名称不会在页面、通知或详情中被有限规则覆盖而失去可追溯性。
 */
export function displayChineseGameName(nameZh: string, nameEn: string): string {
  // 仅用去空白后的值判断是否缺失，但返回原始已保存名称以保持官方或人工确认文本不被展示层改写。
  if (nameZh.trim()) return nameZh;

  // 没有已保存中文名时原样回退英文官方标题；不调用猜测翻译，确保未知商品不会获得错误的中文身份。
  return nameEn;
}
