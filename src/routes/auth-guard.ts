/** 管理路由只需要验证会话摘要；实现可以是 AuthService 或测试中的受控会话读取器。 */
export interface SessionReader {
  authenticate(token: string, now: string): Promise<boolean>;
}

/**
 * 管理 API 的共享会话守卫。它故意只返回布尔值：路由无需知道令牌、管理员资料或数据库细节，
 * 并可统一把 false 映射为 401，避免不同路由出现不一致的认证错误和信息泄露。
 */
export async function requireAdmin(request: Request, sessions: SessionReader): Promise<boolean> {
  const token = readSessionCookie(request.headers.get("cookie"));
  return sessions.authenticate(token, new Date().toISOString());
}

/**
 * 仅提取精确名称的 session Cookie；请求可同时带有分析或偏好 Cookie，
 * 这些字段绝不能被当作会话令牌，也不能把整段 Cookie 请求头传入哈希查询。
 */
function readSessionCookie(cookieHeader: string | null): string {
  if (!cookieHeader) return "";
  const entry = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("session="));
  return entry ? entry.slice("session=".length) : "";
}
