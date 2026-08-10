import { initialRegionCodes, type RegionCode } from "../shared/domain";
import {
  AuthService,
  ConflictError,
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  LoginLockedError,
  ValidationError,
} from "../services/auth-service";
import type { SessionReader } from "./auth-guard";

/**
 * 认证路由依赖由运行时入口显式装配。cookieSecure 不能从 Forwarded 或 X-Forwarded-Proto 推断，
 * 因为这些请求头可能由客户端伪造；部署层必须按实际 HTTPS 终止边界传入固定策略。
 */
export interface AuthRouteDependencies {
  auth: AuthService;
  sessions: SessionReader;
  cookieSecure: boolean;
  /** 仅由启动配置显式开启的本机开发旁路；路由绝不从请求、Cookie 或浏览器地址自行推断。 */
  localDevelopmentAuthBypass?: boolean;
}

/**
 * 集中处理首次初始化和登录接口；仅显式本机开发旁路可固定状态查询为直入，其他环境保留密码、恢复码与会话语义。
 * 不回显密码、恢复码哈希或会话哈希，且只在首次初始化响应中返回一次明文恢复码。
 */
export async function handleAuthRoute(
  request: Request,
  dependencies: AuthRouteDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const isStatus = request.method === "GET" && path === "/api/auth/status";
  // 仅列出的 POST 路由由认证模块消费；其余请求交回 Node 主分派器，避免遮蔽未来的静态资源或 API。
  const isAuthAction = request.method === "POST" &&
    ["/api/auth/initialize", "/api/auth/login", "/api/auth/recover", "/api/auth/logout"].includes(path);
  if (!isStatus && !isAuthAction) return null;

  try {
    // 本机旁路必须由进程启动配置明确授予；缺失或 false 时仍读取真实数据库与 Cookie，防止 NAS/公网意外无认证。
    if (isStatus && dependencies.localDevelopmentAuthBypass === true) {
      return Response.json({ initialized: true, authenticated: true });
    }
    // 非旁路状态端点只返回两个布尔值；数据库异常也必须进入统一安全 500，不能把内部消息抛给运行时默认响应。
    if (isStatus) {
      return Response.json({
        initialized: await dependencies.auth.isInitialized(),
        authenticated: await dependencies.sessions.authenticate(
          readSessionCookie(request.headers.get("cookie")),
          new Date().toISOString(),
        ),
      });
    }

    const auth = dependencies.auth;
    const now = new Date().toISOString();
    // 退出仅依赖 Cookie，允许空正文；其余端点才读取 JSON，避免空请求被 JSON 解析错误拦截。
    if (path === "/api/auth/logout") {
      // 即使 Cookie 缺失也返回成功并覆盖浏览器 Cookie，防止退出接口泄露会话是否存在。
      await auth.logout(readSessionCookie(request.headers.get("cookie")), now);
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": clearSessionCookie(dependencies.cookieSecure) },
      });
    }

    // 标准 Fetch Request.json 不提供类型参数；先恢复 unknown 信任边界，再拒绝非对象载荷，不能让 DOM 的 any 绕过认证字段收窄。
    const untrustedBody = (await request.json()) as unknown;
    if (typeof untrustedBody !== "object" || untrustedBody === null || Array.isArray(untrustedBody)) {
      throw new ValidationError("请求内容必须是对象。");
    }
    const body = untrustedBody as Record<string, unknown>;
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
    return authErrorResponse(error);
  }
}

/**
 * 只有本模块已知的领域错误允许使用其预设安全中文文案；未知驱动、SQL、网络或非 Error 异常统一固定 500，
 * 既不读取其 message，也不把内部错误码、表名、连接信息或认证材料返回浏览器。
 */
function authErrorResponse(error: unknown): Response {
  if (error instanceof ConflictError) {
    return Response.json({ code: error.code, error: error.message }, { status: 409 });
  }
  if (error instanceof LoginLockedError) {
    return Response.json({ code: error.code, error: error.message }, { status: 429 });
  }
  if (error instanceof InvalidCredentialsError || error instanceof InvalidRecoveryCodeError) {
    return Response.json({ code: error.code, error: error.message }, { status: 401 });
  }
  if (error instanceof ValidationError) {
    return Response.json({ code: error.code, error: error.message }, { status: 422 });
  }
  return Response.json(
    { code: "INTERNAL_ERROR", error: "认证暂时无法处理，请稍后重试。" },
    { status: 500 },
  );
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

/**
 * 安全属性必须每次登录一致：HttpOnly 阻止前端脚本读取令牌，SameSite=Strict 禁止跨站请求携带会话；
 * Secure 只使用受信入口的显式配置，不能依据客户端可伪造的转发头自动改变。
 */
function makeSessionCookie(token: string, secure: boolean): string {
  return `session=${token}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=2592000`;
}

/** 覆盖 Cookie 并立即到期；退出与登录使用相同 Strict/Secure 属性，确保浏览器能删除精确同源 Cookie。 */
function clearSessionCookie(secure: boolean): string {
  return `session=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=0`;
}
