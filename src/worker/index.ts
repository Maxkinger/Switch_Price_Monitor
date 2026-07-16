/**
 * Worker HTTP 入口把健康检查、认证 API 与静态前端资源分层处理。
 * 价格提供方、D1 和 Telegram 凭据只会在 Worker 侧使用，浏览器不会获得直接访问能力。
 */
import { handleAuthRoute } from "./routes/auth-routes";

export interface Env {
  /** 静态资源绑定仅服务前端文件；所有敏感业务操作必须走下方 Worker API。 */
  ASSETS: Fetcher;
  /** D1 是价格历史与管理员配置的唯一持久化入口，前端绝不能直接访问。 */
  DB: D1Database;
}

/** Cloudflare 导出的唯一请求处理器；后续受保护业务路由应在静态资源回退前注册。 */
const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    // 健康检查不依赖数据库或凭据，便于部署平台和本地环境安全探测服务存活。
    if (new URL(request.url).pathname === "/api/health") {
      return Response.json({ ok: true, service: "switch-price-monitor" });
    }

    // 认证路由必须在静态资源前处理，避免密码请求被错误当作前端文件。
    const authResponse = await handleAuthRoute(request, env.DB);
    if (authResponse) return authResponse;

    // 非 API 请求交给静态资源层，避免把 React 文件路由与业务 API 混在一起。
    return env.ASSETS.fetch(request);
  },
};

export default worker;
