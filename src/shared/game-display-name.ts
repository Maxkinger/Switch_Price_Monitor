/**
 * 将服务端确认的简体中文名称转换为页面可直接呈现的文本。
 * `null` 是名称目录尚未补充的业务状态，必须使用固定占位而非官方外文标题或浏览器词表推断；
 * 这样仪表盘和详情页不会把未审核的翻译误表示为管理员已确认的游戏身份。
 */
export function displayGameName(displayNameZhCn: string | null): string {
  return displayNameZhCn ?? "待补充中文名称";
}
