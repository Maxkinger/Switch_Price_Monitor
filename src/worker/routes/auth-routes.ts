import { initialRegionCodes, type RegionCode } from "../../shared/domain";
import {
  AuthService,
  ConflictError,
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  LoginLockedError,
  ValidationError,
} from "../services/auth-service";

/**
 * 集中处理首次初始化和登录接口；这里不回显密码、恢复码哈希或会话哈希，
 * 只在首次初始化响应中返回一次明文恢复码。
 */
export async function handleAuthRoute(request: Request, database: D1Database): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // 仅列出的 POST 路由由认证模块消费；其余请求交回 Worker 主路由，避免遮蔽未来的静态资源或 API。
  if (request.method !== "POST" || !["/api/auth/initialize", "/api/auth/login", "/api/auth/recover", "/api/auth/logout"].includes(path)) return null;

  try {
    const auth = new AuthService(database);
    const now = new Date().toISOString();
    // 退出仅依赖 Cookie，允许空正文；其余端点才读取 JSON，避免空请求被 JSON 解析错误拦截。
    if (path === "/api/auth/logout") {
      // 即使 Cookie 缺失也返回成功并覆盖浏览器 Cookie，防止退出接口泄露会话是否存在。
      await auth.logout(readSessionCookie(request.headers.get("cookie")), now);
      return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie() } });
    }

    const body = await request.json<Record<string, unknown>>();
    if (path === "/api/auth/initialize") {
      const result = await auth.initialize({
        password: String(body.password ?? ""),
        enabledRegions: readRegionCodes(body.enabledRegions),
        defaultSearchRegion: readRegionCode(body.defaultSearchRegion),
        now,
      });
      return Response.json(result, { status: 201 });
    }

    if (path === "/api/auth/recover") {
      await auth.resetPassword(String(body.recoveryCode ?? ""), String(body.password ?? ""), now);
      // 恢复操作不返回秘密或账户状态；204 也让前端无需解析可能意外包含敏感值的响应体。
      return new Response(null, { status: 204 });
    }

    const session = await auth.login(String(body.password ?? ""), now);
    return Response.json(
      { expiresAt: session.expiresAt },
      { headers: { "set-cookie": makeSessionCookie(session.token) } },
    );
  } catch (error) {
    const status = error instanceof ConflictError
      ? 409
      : error instanceof LoginLockedError
        ? 429
        : error instanceof InvalidCredentialsError || error instanceof InvalidRecoveryCodeError
          ? 401
          : error instanceof ValidationError
            ? 422
            : 400;
    // 错误码供前端做无敏感信息的交互分支；错误文本不包含密码、恢复码、令牌或数据库细节。
    return Response.json({ code: error instanceof Error && "code" in error ? error.code : "BAD_REQUEST", error: error instanceof Error ? error.message : "请求无效。" }, { status });
  }
}

/**
 * 首次初始化只接受 MVP 明确支持的地区代码。未知值一律拒绝而非静默丢弃，
 * 否则用户会误以为某地区已启用，实际却不会被采集。
 */
function readRegionCodes(value: unknown): RegionCode[] {
  if (!Array.isArray(value) || value.some((region) => !isRegionCode(region))) throw new ValidationError("地区选择无效。");
  return value;
}

/** 默认搜索区必须是单个已知代码，具体是否属于已选地区由服务层执行业务约束。 */
function readRegionCode(value: unknown): RegionCode {
  if (!isRegionCode(value)) throw new ValidationError("默认搜索区无效。");
  return value;
}

/** 使用共享的受支持地区集合做运行时窄化，不能信任浏览器 JSON 的 TypeScript 类型断言。 */
function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === "string" && initialRegionCodes.includes(value as RegionCode);
}

/**
 * Cookie 请求头可能含有多个键值；只读取名为 session 的第一个值，
 * 不把任意整段请求头当作令牌，以缩小伪造 Cookie 的影响范围。
 */
function readSessionCookie(cookieHeader: string | null): string {
  if (!cookieHeader) return "";
  const entry = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("session="));
  return entry ? entry.slice("session=".length) : "";
}

/** 安全属性必须每次登录一致，避免未来路由遗漏 HttpOnly、Secure 或 SameSite 保护。 */
function makeSessionCookie(token: string): string {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

/** 覆盖 Cookie 并立即到期，配合服务端 revoked_at 实现客户端和服务端双重退出。 */
function clearSessionCookie(): string {
  return "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}
