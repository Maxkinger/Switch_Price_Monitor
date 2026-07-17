/**
 * 应用支持的最小地址栏状态。站点没有引入外部路由包，因此未知路径必须明确回退仪表盘，
 * 避免静态资源回退后出现一个看似加载成功、实际没有功能的空白页面。
 */
export type AppRoute =
  | { kind: "dashboard" }
  | { kind: "subscription-new" }
  | { kind: "subscription-detail"; subscriptionId: string };

/** 仪表盘为认证后的稳定首页；保留单独函数避免组件散落字符串路径。 */
export function dashboardPath(): string {
  return "/";
}

/** 添加订阅继续复用已存在的官方确认向导，不能绕过它直接创建未核验地区商品。 */
export function subscriptionNewPath(): string {
  return "/subscriptions/new";
}

/**
 * 将内部订阅标识编码进单段路径。编码防止包含斜杠或空格的未来标识被解释为多个 URL 段，
 * 而 ID 的权限和存在性仍由 Worker 会话守卫与参数化查询负责。
 */
export function subscriptionDetailPath(subscriptionId: string): string {
  return `/subscriptions/${encodeURIComponent(subscriptionId)}`;
}

/**
 * 从浏览器 pathname 收窄为可渲染页面。只匹配完整的单段详情地址，
 * 以免 `/subscriptions/:id/disable` 等 API 风格路径被前端错误当作可展示详情。
 */
export function readAppRoute(pathname: string): AppRoute {
  if (pathname === "/" || pathname === "/dashboard") return { kind: "dashboard" };
  if (pathname === "/subscriptions/new") return { kind: "subscription-new" };
  const match = pathname.match(/^\/subscriptions\/([^/]+)$/);
  if (!match) return { kind: "dashboard" };
  try {
    return { kind: "subscription-detail", subscriptionId: decodeURIComponent(match[1]) };
  } catch {
    // 非法百分号编码没有可靠的订阅 ID；回退首页比向页面传播 URIError 更安全且可恢复。
    return { kind: "dashboard" };
  }
}
