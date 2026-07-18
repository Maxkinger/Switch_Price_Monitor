/**
 * Worker HTTP 入口把健康检查、认证 API 与静态前端资源分层处理。
 * 价格提供方、D1 和 Telegram 凭据只会在 Worker 侧使用，浏览器不会获得直接访问能力。
 */
import { handleAuthRoute } from "./routes/auth-routes";
import { handleDashboardRoute } from "./routes/dashboard-routes";
import { handleExportRoute } from "./routes/export-routes";
import { handleHistoryRoute } from "./routes/history-routes";
import { handleManualRefreshRoute } from "./routes/manual-refresh-routes";
import { handleProductRoute } from "./routes/product-routes";
import { handleSettingsRoute } from "./routes/settings-routes";
import { handleSubscriptionRoute } from "./routes/subscription-routes";
import { createNintendoPriceApiProvider } from "./providers/official-nintendo-price-api";
import { createOfficialProviderRegistry } from "./providers/official-provider-registry";
import { ProviderChain } from "./providers/provider-chain";
import { createFrankfurterExchangeRateProvider } from "./providers/frankfurter-exchange-rate";
import { createOfficialNintendoProductPageResolver } from "./providers/official-nintendo-product-page";
import { createOfficialNintendoSearch } from "./providers/official-nintendo-search";
import { RetentionRepository } from "./repositories/retention-repository";
import { CollectionRepository } from "./repositories/collection-repository";
import { ExchangeRateRepository } from "./repositories/exchange-rate-repository";
import { PriceRepository } from "./repositories/price-repository";
import { NotificationEventRepository } from "./repositories/notification-event-repository";
import { SettingsRepository } from "./repositories/settings-repository";
import { SubscriptionConfirmationRepository } from "./repositories/subscription-confirmation-repository";
import { DashboardService } from "./services/dashboard-service";
import { OfficialPriceIdService } from "./services/official-price-id-service";
import { OfficialProductDiscoveryService } from "./services/official-product-discovery-service";
import type { DailyReportSubscription } from "./services/report-service";
import { RetentionService } from "./services/retention-service";
import { CollectionService } from "./services/collection-service";
import { DailyCnyRateService } from "./services/daily-cny-rate-service";
import { LiveCollectionRunner } from "./services/live-collection-runner";
import { ProductHealthService } from "./services/product-health-service";
import { runPendingNotificationDelivery, runScheduled, runSixHourCollection } from "./services/scheduler-service";
import { defaultFallbackSources, SubscriptionPreviewService } from "./services/subscription-preview-service";
import { SubscriptionConfirmationService } from "./services/subscription-confirmation-service";
import { SubscriptionRegionCompletionService } from "./services/subscription-region-completion-service";
import { JapaneseSubscriptionConfirmationService } from "./services/japanese-subscription-confirmation-service";
import { TelegramService } from "./services/telegram-service";

export interface Env {
  /** 静态资源绑定仅服务前端文件；所有敏感业务操作必须走下方 Worker API。 */
  ASSETS: Fetcher;
  /** Browser Binding 只服务日区升级关系；不得传入价格采集、Cron、通知或前端响应，避免扩大浏览器会话的使用范围。 */
  BROWSER: Fetcher;
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

    // 手动刷新只允许管理员在请求内立即执行一次采集；冷却状态限制频率，防止匿名访问或重复点击放大外部来源负载。
    const manualRefreshResponse = await handleManualRefreshRoute(request, env.DB, createLiveCollectionRunner(env));
    if (manualRefreshResponse) return manualRefreshResponse;

    // 历史快照属于管理员私有价格轨迹，必须在静态资源回退前进行会话校验和查询参数验证。
    const historyResponse = await handleHistoryRoute(request, env.DB);
    if (historyResponse) return historyResponse;

    // 导出可包含长期价格轨迹，必须通过管理员会话并由白名单导出服务生成，不能交给静态层或任意 SQL。
    const exportResponse = await handleExportRoute(request, env.DB);
    if (exportResponse) return exportResponse;

    // 商品发现与最终确认必须在会话守卫前由路由统一保护；每个请求构造无状态服务，避免在 Worker 实例间缓存候选 URL 或外部响应。
    const officialPages = createOfficialNintendoProductPageResolver();
    const officialSearch = createOfficialNintendoSearch();
    // 同一个官方解析器同时提供详情复核与港区一层关系能力；发现服务仍通过两个窄接口消费，避免把递归展开权限泄漏给普通详情调用方。
    const officialDiscovery = new OfficialProductDiscoveryService(
      new SettingsRepository(env.DB),
      officialSearch,
      officialPages,
      officialPages,
    );
    const officialPriceIds = new OfficialPriceIdService(createNintendoPriceApiProvider());
    const productResponse = await handleProductRoute(
      request,
      env.DB,
      new SubscriptionPreviewService(officialPriceIds, defaultFallbackSources),
      // 商品发现只在管理员会话通过后由路由触发；服务端构造可确保官网搜索配置、商品页请求和用户浏览器完全隔离。
      officialDiscovery,
      // 最终确认复用本区页面解析器、日区双官方接口确认器与持久化设置，
      // 确保发现时与写入前使用同一地区安全范围，旧浏览器页面也不能绕过启用地区覆盖校验。
      new SubscriptionConfirmationService(
        new SubscriptionConfirmationRepository(env.DB),
        officialPages,
        officialPriceIds,
        new SettingsRepository(env.DB),
        // 日区最终确认不再解析可能返回排队外壳的 Store 页面；两项任天堂官方接口分别证明身份字段与在售价格状态。
        new JapaneseSubscriptionConfirmationService(createOfficialNintendoSearch(), officialPriceIds),
        // 非日区 automatic 候选写入前复用同一请求内的官方发现实例，重新证明 URL 仍唯一，不能信任浏览器保存的旧状态。
        officialDiscovery,
      ),
    );
    if (productResponse) return productResponse;

    // 订阅写入会改变后续采集与通知范围，因此必须在静态资源回退之前进入带会话校验的管理 API。
    const subscriptionResponse = await handleSubscriptionRoute(
      request,
      env.DB,
      // 已有订阅补全复用同一官方页面、价格 ID、设置与跨区发现服务；这样新建和补全遵守相同的地区安全边界。
      new SubscriptionRegionCompletionService(
        new SubscriptionConfirmationRepository(env.DB),
        officialPages,
        officialPriceIds,
        new SettingsRepository(env.DB),
        // 已有订阅补全使用独立的无状态发现实例，但共享同一请求内的官方适配器；不会缓存或跨用户复用候选。
        new OfficialProductDiscoveryService(new SettingsRepository(env.DB), officialSearch, officialPages, officialPages),
      ),
    );
    if (subscriptionResponse) return subscriptionResponse;

    // 非 API 请求交给静态资源层，避免把 React 文件路由与业务 API 混在一起。
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const scheduledAt = new Date(event.scheduledTime).toISOString();
    // 六小时任务只执行历史维护与一次真实采集；手动刷新已由 HTTP 请求同步完成，
    // 因此不能读取其冷却记录，避免把状态记录误当成待执行队列并破坏固定采集频率。
    if (event.cron === "0 */6 * * *") {
      const collection = createLiveCollectionRunner(env);
      ctx.waitUntil(runSixHourCollection(scheduledAt, {
        settings: new SettingsRepository(env.DB),
        retention: new RetentionService(new RetentionRepository(env.DB)),
        collection,
      }));
      return;
    }
    // 每分钟 Cron 负责日报时刻判断与待发送即时通知；未知 Cron 必须忽略以避免配置错误意外触发外部 Telegram 请求。
    if (event.cron !== "* * * * *") return;
    const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? new TelegramService({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID })
      : undefined;
    // DashboardService 的结果完全由本 Worker 构造；在单一适配点收窄为日报 DTO，避免在 Telegram 服务传播宽松的数据库读取类型。
    const overview = new DashboardService(env.DB);
    // 即时事件不等日报时刻：成功后才由仓储原子更新为 delivered，失败则保持 pending 留给下一分钟重试。
    ctx.waitUntil(runPendingNotificationDelivery(scheduledAt, {
      events: new NotificationEventRepository(env.DB),
      marker: new NotificationEventRepository(env.DB),
      telegram,
    }));
    ctx.waitUntil(runScheduled(scheduledAt, {
      settings: new SettingsRepository(env.DB),
      overview: { getOverview: async () => ({ subscriptions: (await overview.getOverview()).subscriptions as unknown as DailyReportSubscription[] }) },
      telegram,
    }));
  },
};

/**
 * 统一装配自动与手动采集器，确保两条入口使用相同的官方来源、每日汇率、价格快照、健康检查和降价事件规则。
 * 工厂每次仅创建无状态服务对象，不会在 Worker 实例间缓存管理员会话、外部页面响应或任何 Telegram 凭据。
 */
function createLiveCollectionRunner(env: Env): LiveCollectionRunner {
  const prices = new PriceRepository(env.DB);
  return new LiveCollectionRunner({
    products: new CollectionRepository(env.DB),
    rates: new DailyCnyRateService(createFrankfurterExchangeRateProvider(), new ExchangeRateRepository(env.DB)),
    officialProviders: createOfficialProviderRegistry(),
    collection: new CollectionService(new ProviderChain(), prices),
    health: new ProductHealthService(env.DB),
    previousOfficial: prices,
    events: new NotificationEventRepository(env.DB),
  });
}

export default worker;
