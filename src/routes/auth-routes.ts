import { initialRegionCodes, type RegionCode } from "../shared/domain";
import {
  AuthService,
  ConflictError,
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  LoginLockedError,
  type SessionReader,
  ValidationError,
} from "../services/auth-service";
import { readSessionCookie } from "./auth-guard";

/** 认证 HTTP 层只依赖平台中立服务；Node 与过渡 Worker 分别在入口装配 PostgreSQL 或 D1 仓储。 */
export interface AuthRouteDependencies {
  auth: Pick<AuthService, "isInitialized" | "initialize" | "login" | "resetPassword" | "logout">;
  sessions: SessionReader;
  /**
   * Cookie Secure 必须由可信启动配置显式决定，绝不能读取 Forwarded/X-Forwarded-Proto 等可伪造请求头自动降级。
   * 局域网 HTTP 首阶段传 false，未来 HTTPS/FRP 入口由部署者改为 true，认证业务无需再次修改。
   */
  cookieSecure: boolean;
  /** 测试可注入固定时钟；生产装配省略时使用进程当前 UTC 时间，浏览器提交时间永远不被采信。 */
  now?: () => string;
}

/**
 * 集中处理首次初始化和登录接口；这里不回显密码、恢复码哈希或会话哈希，
 * 只在首次初始化响应中返回一次明文恢复码。
 */
export async function handleAuthRoute(request: Request, dependencies: AuthRouteDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // 此公开状态端点只返回首次设置与当前 Cookie 的有效性两个布尔值，供 SPA 刷新后安全恢复界面；绝不返回令牌、管理员资料或地区配置。
  if (request.method === "GET" && path === "/api/auth/status") {
    try {
      const now = (dependencies.now ?? defaultNow)();
      return Response.json({
        initialized: await dependencies.auth.isInitialized(),
        authenticated: await dependencies.sessions.authenticate(readSessionCookie(request.headers.get("cookie")), now),
      });
    } catch {
      // 公开状态读取失败也不能泄漏连接串、SQL 或驱动正文；前端只需知道认证服务暂不可用并稍后重试。
      return Response.json({ code: "INTERNAL_ERROR", error: "认证暂时无法处理，请稍后重试。" }, { status: 500 });
    }
  }
  // 仅列出的 POST 路由由认证模块消费；其余请求交回上层 HTTP 分发器，避免遮蔽未来的静态资源或 API。
  if (request.method !== "POST" || !["/api/auth/initialize", "/api/auth/login", "/api/auth/recover", "/api/auth/logout"].includes(path)) return null;

  try {
    const auth = dependencies.auth;
    const now = (dependencies.now ?? defaultNow)();
    // 退出仅依赖 Cookie，允许空正文；其余端点才读取 JSON，避免空请求被 JSON 解析错误拦截。
    if (path === "/api/auth/logout") {
      // 即使 Cookie 缺失也返回成功并覆盖浏览器 Cookie，防止退出接口泄露会话是否存在。
      await auth.logout(readSessionCookie(request.headers.get("cookie")), now);
      return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie(dependencies.cookieSecure) } });
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
      { headers: { "set-cookie": makeSessionCookie(session.token, dependencies.cookieSecure) } },
    );
  } catch (error) {
    const isKnownError = error instanceof ConflictError
      || error instanceof LoginLockedError
      || error instanceof InvalidCredentialsError
      || error instanceof InvalidRecoveryCodeError
      || error instanceof ValidationError;
    const status = error instanceof ConflictError
      ? 409
      : error instanceof LoginLockedError
        ? 429
        : error instanceof InvalidCredentialsError || error instanceof InvalidRecoveryCodeError
          ? 401
          : error instanceof ValidationError
            ? 422
            : 500;
    // 错误码供前端做无敏感信息的交互分支；错误文本不包含密码、恢复码、令牌或数据库细节。
    return Response.json({
      code: isKnownError && error instanceof Error && "code" in error ? error.code : "INTERNAL_ERROR",
      error: isKnownError && error instanceof Error ? error.message : "认证暂时无法处理，请稍后重试。",
    }, { status });
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
 * 安全属性必须每次登录一致：HttpOnly 阻止脚本读取，SameSite=Strict 限制跨站携带，Path=/ 保持同源 API 可用。
 * Secure 只由可信配置添加；这里有意不读取请求头，防止反向代理头被局域网客户端伪造后改变 Cookie 安全级别。
 */
function makeSessionCookie(token: string, secure: boolean): string {
  return `session=${token}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=2592000`;
}

/** 覆盖 Cookie 并立即到期，配合服务端 revoked_at 实现客户端和服务端双重退出。 */
function clearSessionCookie(secure: boolean): string {
  return `session=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=0`;
}

/** 统一生成 UTC ISO 服务端时刻，认证、会话过期与数据库 TIMESTAMPTZ 使用同一绝对时间口径。 */
function defaultNow(): string {
  return new Date().toISOString();
}
