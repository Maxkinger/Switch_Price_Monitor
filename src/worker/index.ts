/**
 * Worker HTTP 入口把健康检查、认证 API 与静态前端资源分层处理。
 * 价格提供方、D1 和 Telegram 凭据只会在 Worker 侧使用，浏览器不会获得直接访问能力。
 */
import { handleAuthRoute } from "../routes/auth-routes";
import { handleDashboardRoute } from "../routes/dashboard-routes";
import { handleExportRoute } from "../routes/export-routes";
import { handleHistoryRoute } from "../routes/history-routes";
import { handleManualRefreshRoute } from "../routes/manual-refresh-routes";
import { handleProductRoute } from "../routes/product-routes";
import { handleSettingsRoute } from "../routes/settings-routes";
import { handleSubscriptionRoute } from "../routes/subscription-routes";
import { createNintendoOfficialPriceQuoteResolver, createNintendoPriceApiProvider } from "../providers/official-nintendo-price-api";
import { createOfficialJapaneseUpgradeRootSearch } from "../providers/official-japanese-upgrade-root";
import { createJapaneseUpgradeBrowserBatch } from "../providers/playwright/japanese-upgrade-browser";
import { createOfficialProviderRegistry } from "../providers/official-provider-registry";
import { ProviderChain } from "../providers/provider-chain";
import { createFrankfurterExchangeRateProvider } from "../providers/frankfurter-exchange-rate";
import { createOfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import { createOfficialNintendoSearch } from "../providers/official-nintendo-search";
import { RetentionRepository } from "../repositories/retention-repository";
import { CollectionRepository } from "../repositories/collection-repository";
import { ExchangeRateRepository } from "../repositories/exchange-rate-repository";
import { PriceRepository } from "../repositories/price-repository";
import { NotificationEventRepository } from "../repositories/notification-event-repository";
import { ProductHealthRepository } from "../repositories/product-health-repository";
import { SettingsRepository } from "../repositories/settings-repository";
import { SubscriptionConfirmationRepository } from "../repositories/subscription-confirmation-repository";
import { AuthRepository as D1AuthRepository } from "../repositories/d1/auth-repository";
import { ExportRepository as D1ExportRepository } from "../repositories/d1/export-repository";
import { HistoryRepository as D1HistoryRepository } from "../repositories/d1/history-repository";
import { DashboardRepository } from "../repositories/d1/dashboard-repository";
import { ManualRefreshRepository as D1ManualRefreshRepository } from "../repositories/manual-refresh-repository";
import { SubscriptionDetailRepository as D1SubscriptionDetailRepository } from "../repositories/subscription-detail-repository";
import { SubscriptionRepository as D1SubscriptionRepository } from "../repositories/subscription-repository";
import { AuthService } from "../services/auth-service";
import { DashboardService } from "../services/dashboard-service";
import { ExportService } from "../services/export-service";
import { HistoryService } from "../services/history-service";
import { ManualRefreshService } from "../services/manual-refresh-service";
import { OfficialPriceIdService } from "../services/official-price-id-service";
import { OfficialProductDiscoveryService } from "../services/official-product-discovery-service";
import type { DailyReportSubscription } from "../services/report-service";
import { RetentionService } from "../services/retention-service";
import { CollectionService } from "../services/collection-service";
import { DailyCnyRateService } from "../services/daily-cny-rate-service";
import { LiveCollectionRunner } from "../services/live-collection-runner";
import { ProductHealthService } from "../services/product-health-service";
import { runPendingNotificationDelivery, runScheduled, runSixHourCollection } from "../services/scheduler-service";
import { defaultFallbackSources, SubscriptionPreviewService } from "../services/subscription-preview-service";
import { SubscriptionConfirmationService } from "../services/subscription-confirmation-service";
import { SubscriptionDetailService } from "../services/subscription-detail-service";
import { SubscriptionRegionCompletionService } from "../services/subscription-region-completion-service";
import { SubscriptionService } from "../services/subscription-service";
import { SettingsService } from "../services/settings-service";
import { JapaneseSubscriptionConfirmationService } from "../services/japanese-subscription-confirmation-service";
import { createJapaneseUpgradeRelationService } from "../services/japanese-upgrade-relation-service";
import { TelegramService } from "../services/telegram-service";

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

    // 过渡 Worker 为每个请求装配同一个认证服务实例；路由和守卫只见平台中立接口，Task 5 可直接替换为 PostgreSQL 仓储。
    const auth = new AuthService(new D1AuthRepository(env.DB));
    // 认证路由必须在静态资源前处理，避免密码请求被错误当作前端文件；Cloudflare HTTPS 明确要求 Secure，不能从请求头推断。
    const authResponse = await handleAuthRoute(request, { auth, sessions: auth, cookieSecure: true });
    if (authResponse) return authResponse;

    // 全局设置会影响后续商品搜索、主题与日报调度，必须由管理员会话保护并先于静态资源回退处理。
    const settingsResponse = await handleSettingsRoute(request, {
      sessions: auth,
      settings: new SettingsService(new SettingsRepository(env.DB)),
    });
    if (settingsResponse) return settingsResponse;

    // 仪表盘聚合订阅和价格历史，属于管理员私有信息，必须在静态资源层之前完成会话校验。
    const dashboardResponse = await handleDashboardRoute(request, {
      sessions: auth,
      dashboard: new DashboardService(new DashboardRepository(env.DB)),
    });
    if (dashboardResponse) return dashboardResponse;

    // 手动刷新只允许管理员在请求内立即执行一次采集；当前无冷却，但会话校验、统一来源链和单行最大 UTC 审计时间仍阻止匿名写入与时间倒退。
    const manualRefreshResponse = await handleManualRefreshRoute(request, {
      sessions: auth,
      refresh: new ManualRefreshService(new D1ManualRefreshRepository(env.DB), createLiveCollectionRunner(env)),
    });
    if (manualRefreshResponse) return manualRefreshResponse;

    // 历史快照属于管理员私有价格轨迹，必须在静态资源回退前进行会话校验和查询参数验证。
    const historyResponse = await handleHistoryRoute(request, {
      sessions: auth,
      history: new HistoryService(new D1HistoryRepository(env.DB)),
    });
    if (historyResponse) return historyResponse;

    // 导出可包含长期价格轨迹，必须通过管理员会话并由白名单导出服务生成，不能交给静态层或任意 SQL。
    const exportResponse = await handleExportRoute(request, {
      sessions: auth,
      exports: new ExportService(new D1ExportRepository(env.DB)),
    });
    if (exportResponse) return exportResponse;

    // 商品发现与最终确认必须在会话守卫前由路由统一保护；每个请求构造无状态服务，避免在 Worker 实例间缓存候选 URL 或外部响应。
    const officialPages = createOfficialNintendoProductPageResolver();
    const officialSearch = createOfficialNintendoSearch();
    // 每个进入商品路由分发阶段的请求只构造一个无状态关系服务；只有认证后的相关端点才会实际启动 Browser，不进入采集、Cron、通知或 D1 层。
    const japaneseUpgradeRelations = createJapaneseUpgradeRelationService(
      createOfficialJapaneseUpgradeRootSearch(),
      // Cloudflare 过渡入口不再持有 Browser Binding；本地 Node 运行时在 Task 7 以 Playwright 注入真实启动器，Worker 请求安全降级到人工链接。
      createJapaneseUpgradeBrowserBatch(unavailableWorkerBrowserLauncher),
      createNintendoOfficialPriceQuoteResolver(),
    );
    // 同一个官方解析器同时提供详情复核与港区一层关系能力；发现服务仍通过两个窄接口消费，避免把递归展开权限泄漏给普通详情调用方。
    const officialDiscovery = new OfficialProductDiscoveryService(
      new SettingsRepository(env.DB),
      officialSearch,
      officialPages,
      officialPages,
      // 发现阶段与保存前确认共享同一请求级服务对象，保证一次请求内使用相同的三项 Browser Run 上限且不复用跨请求会话。
      japaneseUpgradeRelations,
    );
    const officialPriceIds = new OfficialPriceIdService(createNintendoPriceApiProvider());
    const productResponse = await handleProductRoute(
      request,
      {
        sessions: auth,
        preview: new SubscriptionPreviewService(officialPriceIds, defaultFallbackSources),
        // 商品发现只在管理员会话通过后由路由触发；服务端构造可确保官网搜索配置、商品页请求和用户浏览器完全隔离。
        discovery: officialDiscovery,
        // 最终确认复用本区页面解析器、日区双官方接口确认器与持久化设置，确保旧浏览器页面无法绕过当前地区范围。
        confirmation: new SubscriptionConfirmationService(
          new SubscriptionConfirmationRepository(env.DB),
          officialPages,
          officialPriceIds,
          new SettingsRepository(env.DB),
          // 普通日区商品不再解析可能返回排队外壳的 Store 页面；两项任天堂官方接口分别证明身份字段与在售价格状态。
          new JapaneseSubscriptionConfirmationService(createOfficialNintendoSearch(), officialPriceIds),
          // 所有日区升级包在查询既有订阅或写入前，必须由与发现阶段相同的关系服务整批重新签发证据。
          japaneseUpgradeRelations,
          // 非日区 automatic 候选写入前复用同一请求内的官方发现实例，重新证明 URL 仍唯一，不能信任浏览器保存的旧状态。
          officialDiscovery,
        ),
      },
    );
    if (productResponse) return productResponse;

    // 订阅写入会改变后续采集与通知范围，因此必须在静态资源回退之前进入带会话校验的管理 API。
    const subscriptionResponse = await handleSubscriptionRoute(
      request,
      {
        sessions: auth,
        subscriptions: new SubscriptionService(new D1SubscriptionRepository(env.DB)),
        details: new SubscriptionDetailService(new D1SubscriptionDetailRepository(env.DB)),
        // 已有订阅补全复用同一官方页面、价格 ID、设置与跨区发现服务；这样新建和补全遵守相同的地区安全边界。
        completion: new SubscriptionRegionCompletionService(
          new SubscriptionConfirmationRepository(env.DB),
          officialPages,
          officialPriceIds,
          new SettingsRepository(env.DB),
          // 已有订阅补全使用独立的无状态发现实例，但共享同一请求内的官方适配器；不会缓存或跨用户复用候选。
          new OfficialProductDiscoveryService(new SettingsRepository(env.DB), officialSearch, officialPages, officialPages),
        ),
      },
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
    // 调度器继续使用现有 D1 绑定，但通过仓储端口读取统一 DTO；后续 PostgreSQL Node 装配无需改动日报业务规则。
    const overview = new DashboardService(new DashboardRepository(env.DB));
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
    // 过渡期 Worker 仍装配 D1 适配器，但服务只接收窄端口；后续 Node 入口可替换为 PostgreSQL 而无需改健康业务规则。
    health: new ProductHealthService(new ProductHealthRepository(env.DB), new NotificationEventRepository(env.DB)),
    previousOfficial: prices,
    events: new NotificationEventRepository(env.DB),
  });
}

/** Worker 过渡期禁止启动本地 Chromium；统一抛出无细节错误后由批处理器映射为 browser-unavailable，不能把运行时差异泄漏给前端。 */
const unavailableWorkerBrowserLauncher = {
  async launch(): Promise<never> {
    throw new Error("本地浏览器仅由 Node 运行时提供。");
  },
};

export default worker;
