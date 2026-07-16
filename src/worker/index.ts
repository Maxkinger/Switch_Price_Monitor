/**
 * Worker HTTP 入口把健康检查、认证 API 与静态前端资源分层处理。
 * 价格提供方、D1 和 Telegram 凭据只会在 Worker 侧使用，浏览器不会获得直接访问能力。
 */
import { handleAuthRoute } from "./routes/auth-routes";
import { handleDashboardRoute } from "./routes/dashboard-routes";
import { handleExportRoute } from "./routes/export-routes";
import { handleHistoryRoute } from "./routes/history-routes";
import { handleManualRefreshRoute } from "./routes/manual-refresh-routes";
import { handleSettingsRoute } from "./routes/settings-routes";
import { handleSubscriptionRoute } from "./routes/subscription-routes";
import { SettingsRepository } from "./repositories/settings-repository";
import { DashboardService } from "./services/dashboard-service";
import type { DailyReportSubscription } from "./services/report-service";
import { runScheduled } from "./services/scheduler-service";
import { TelegramService } from "./services/telegram-service";

export interface Env {
  /** 静态资源绑定仅服务前端文件；所有敏感业务操作必须走下方 Worker API。 */
  ASSETS: Fetcher;
  /** D1 是价格历史与管理员配置的唯一持久化入口，前端绝不能直接访问。 */
  DB: D1Database;
  /** Telegram 凭据仅由 Cloudflare Secret 在运行时注入；可选字段使未配置部署安全跳过日报。 */
  TELEGRAM_BOT_TOKEN?: string;
  /** Chat ID 与 Bot Token 同样不得回传前端或写入数据库、日志和测试快照。 */
  TELEGRAM_CHAT_ID?: string;
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

    // 全局设置会影响后续商品搜索、主题与日报调度，必须由管理员会话保护并先于静态资源回退处理。
    const settingsResponse = await handleSettingsRoute(request, env.DB);
    if (settingsResponse) return settingsResponse;

    // 仪表盘聚合订阅和价格历史，属于管理员私有信息，必须在静态资源层之前完成会话校验。
    const dashboardResponse = await handleDashboardRoute(request, env.DB);
    if (dashboardResponse) return dashboardResponse;

    // 手动刷新只接受管理员写入队列；不能让静态层或匿名访问绕过十五分钟冷却并放大外部来源负载。
    const manualRefreshResponse = await handleManualRefreshRoute(request, env.DB);
    if (manualRefreshResponse) return manualRefreshResponse;

    // 历史快照属于管理员私有价格轨迹，必须在静态资源回退前进行会话校验和查询参数验证。
    const historyResponse = await handleHistoryRoute(request, env.DB);
    if (historyResponse) return historyResponse;

    // 导出可包含长期价格轨迹，必须通过管理员会话并由白名单导出服务生成，不能交给静态层或任意 SQL。
    const exportResponse = await handleExportRoute(request, env.DB);
    if (exportResponse) return exportResponse;

    // 订阅写入会改变后续采集与通知范围，因此必须在静态资源回退之前进入带会话校验的管理 API。
    const subscriptionResponse = await handleSubscriptionRoute(request, env.DB);
    if (subscriptionResponse) return subscriptionResponse;

    // 非 API 请求交给静态资源层，避免把 React 文件路由与业务 API 混在一起。
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // 每分钟 Cron 专门检查管理员选择的日报时刻；未来六小时采集 Cron 会使用不同表达式接入同一入口。
    if (event.cron !== "* * * * *") return;
    const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? new TelegramService({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID })
      : undefined;
    // DashboardService 的结果完全由本 Worker 构造；在单一适配点收窄为日报 DTO，避免在 Telegram 服务传播宽松的数据库读取类型。
    const overview = new DashboardService(env.DB);
    ctx.waitUntil(runScheduled(new Date(event.scheduledTime).toISOString(), {
      settings: new SettingsRepository(env.DB),
      overview: { getOverview: async () => ({ subscriptions: (await overview.getOverview()).subscriptions as unknown as DailyReportSubscription[] }) },
      telegram,
    }));
  },
};

export default worker;
