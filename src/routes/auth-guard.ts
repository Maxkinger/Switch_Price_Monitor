/** 管理路由只需要验证会话摘要；实现可以是 AuthService 或测试中的受控会话读取器。 */
export interface SessionReader {
  authenticate(token: string, now: string): Promise<boolean>;
}

/**
 * 管理 API 的共享会话守卫。它故意只返回布尔值：路由无需知道令牌、管理员资料或数据库细节，
 * 并可统一把 false 映射为 401，避免不同路由出现不一致的认证错误和信息泄露。
 */
export async function requireAdmin(request: Request, dependency: SessionReader | unknown): Promise<boolean> {
  const token = readSessionCookie(request.headers.get("cookie"));
  const sessions = isSessionReader(dependency)
    ? dependency
    : new AuthService(
      // 仅供旧路由单测过渡；生产 Worker 已显式装配适配器。构造参数类型从适配器本身取得，避免路由重新声明平台类型。
      new D1AuthRepository(
        dependency as ConstructorParameters<typeof D1AuthRepository>[0],
      ),
    );
  return sessions.authenticate(token, new Date().toISOString());
}

/** 运行时仅以窄方法判断显式会话依赖；旧数据库对象没有 authenticate，因而进入临时兼容适配分支。 */
function isSessionReader(value: unknown): value is SessionReader {
  return (
    typeof value === "object" &&
    value !== null &&
    "authenticate" in value &&
    typeof (value as { authenticate?: unknown }).authenticate === "function"
  );
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
import { D1AuthRepository } from "../repositories/auth-repository";
import { AuthService } from "../services/auth-service";
