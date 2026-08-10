/** 管理路由可依赖会话读取器；开发期旁路保留此接口，避免为临时直入改动全部路由装配签名。 */
export interface SessionReader {
  authenticate(token: string, now: string): Promise<boolean>;
}

/**
 * 开发阶段的管理 API 共享直入守卫。它不解析 Cookie、不查询 PostgreSQL 会话，也不将伪造值包装成真实身份；
 * 这样本机功能开发不会被密码流程阻断。所有能访问服务的人都会获得完整权限，因此认证恢复前严禁部署到 NAS、局域网或公网。
 */
export async function requireAdmin(request: Request, sessions: SessionReader): Promise<boolean> {
  // 显式消费参数可保留路由统一签名并让 lint/类型检查确认没有隐式读取会话；恢复认证时必须同时恢复 Cookie 摘要校验。
  void request;
  void sessions;
  return true;
}
