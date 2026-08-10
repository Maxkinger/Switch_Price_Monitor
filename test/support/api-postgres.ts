import { handleAuthRoute } from "../../src/routes/auth-routes";
import { PostgresAuthRepository } from "../../src/repositories/postgres/auth-repository";
import { createServerDependencies } from "../../src/server/dependencies";
import type { AppDatabase } from "../../src/server/database/types";
import { AuthService } from "../../src/services/auth-service";
import { createTestDatabase } from "./postgres";

/** Node API 测试只暴露标准 Fetch dispatcher；外部任天堂、Telegram 与浏览器适配器虽会被装配，但测试不调用对应路由。 */
export type TestApiDispatcher = (request: Request) => Promise<Response | null>;

/**
 * 创建经过破坏性 URL 守卫、真实迁移和独立连接池的一次性 PostgreSQL 测试库。
 * 调用文件必须在 afterAll 关闭连接；Vitest project 禁止文件并行，避免多个文件同时重建同一个 public schema。
 */
export async function createApiTestDatabase(): Promise<AppDatabase> {
  return createTestDatabase();
}

/**
 * 清空全部业务表但保留不可变迁移记录。TRUNCATE 只会在 requireTestDatabaseUrl 已精确验证的
 * 127.0.0.1:54329 一次性库执行；CASCADE 用于按外键清理夹具，绝不能复制到生产请求路径。
 */
export async function resetApiTestData(database: AppDatabase): Promise<void> {
  await database.query(`TRUNCATE TABLE
    manual_refresh_requests,
    login_attempts,
    sessions,
    admin_credentials,
    notification_events,
    regional_product_health,
    fetch_logs,
    exchange_rates,
    price_snapshots,
    subscription_regions,
    subscriptions,
    regional_products,
    games,
    settings
    RESTART IDENTITY CASCADE`);
}

/** 创建真实 PostgreSQL 认证服务；Cookie 原文只在测试请求间传递，数据库始终仅保存摘要。 */
export function createTestAuth(database: AppDatabase): AuthService {
  return new AuthService(new PostgresAuthRepository(database));
}

/**
 * 只装配认证路由，供商品发现等注入外部 fake 的测试建立真实管理员会话。
 * 该辅助函数不会构造任天堂、Telegram 或 Chromium 适配器，避免认证准备阶段产生任何外部访问可能。
 */
export function createTestAuthDispatcher(
  database: AppDatabase,
  cookieSecure = false,
  localDevelopmentAuthBypass = false,
): TestApiDispatcher {
  const auth = createTestAuth(database);
  return (request) => handleAuthRoute(request, {
    auth,
    sessions: auth,
    // LAN HTTP 测试默认不设置 Secure；需要 HTTPS 契约的认证文件会显式传 true。
    cookieSecure,
    // 只有专门的本机开发回归会显式启用旁路，其他认证测试默认保留真实首次初始化和 Cookie 校验。
    localDevelopmentAuthBypass,
  });
}

/**
 * 使用生产 Node 依赖装配建立 API dispatcher。测试只调用数据库内路由；任何需要任天堂、Telegram
 * 或 Chromium 的路径必须在具体测试中改用更窄的 route handler 与受控 fake，禁止意外联网。
 */
export function createTestNodeDispatcher(
  database: AppDatabase,
  cookieSecure = false,
): TestApiDispatcher {
  return createServerDependencies(database, {
    cookieSecure,
    telegramBotToken: undefined,
    telegramChatId: undefined,
  }).http.dispatchApi;
}

/** 固定构造同源 JSON 请求；Cookie 只能来自真实登录响应，测试不得伪造数据库中的 token 摘要。 */
export function jsonRequest(
  path: string,
  body?: unknown,
  cookie?: string | null,
  method = "POST",
): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
  });
}

/**
 * 通过真实初始化与登录路由取得 HttpOnly 会话；返回恢复码仅供明确测试恢复流程的调用方使用，
 * 普通 API 测试不得把它写入日志、快照或持久夹具。
 */
export async function initializeAndLogin(
  database: AppDatabase,
  options: {
    enabledRegions?: string[];
    defaultSearchRegion?: string;
    cookieSecure?: boolean;
  } = {},
): Promise<{ cookie: string; recoveryCode: string }> {
  const dispatch = createTestAuthDispatcher(database, options.cookieSecure ?? false);
  const initialized = await dispatch(jsonRequest("/api/auth/initialize", {
    password: "correct-horse-battery-staple",
    enabledRegions: options.enabledRegions ?? ["US", "JP"],
    defaultSearchRegion: options.defaultSearchRegion ?? "US",
  }));
  if (!initialized || initialized.status !== 201) {
    throw new Error("测试管理员初始化失败");
  }
  const payload = await initialized.json() as { recoveryCode?: unknown };
  if (typeof payload.recoveryCode !== "string") {
    throw new Error("测试管理员初始化未返回一次性恢复码");
  }
  const login = await dispatch(jsonRequest("/api/auth/login", {
    password: "correct-horse-battery-staple",
  }));
  if (!login || login.status !== 200) {
    throw new Error("测试管理员登录失败");
  }
  return {
    cookie: login.headers.get("set-cookie") ?? "",
    recoveryCode: payload.recoveryCode,
  };
}
