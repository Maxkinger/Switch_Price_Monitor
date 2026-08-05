/**
 * HTTP 组合层唯一需要的业务入口。具体 PostgreSQL 仓储、价格来源和 Telegram 凭据在启动装配时构造，
 * 因此静态资源层与测试不能取得数据库连接、会话令牌或外部服务的可变对象。
 */
export interface ServerDependencies {
  dispatchApi(request: Request): Promise<Response | null>;
}

import { handleAuthRoute } from "../routes/auth-routes";
import { handleDashboardRoute } from "../routes/dashboard-routes";
import { handleExportRoute } from "../routes/export-routes";
import { handleHistoryRoute } from "../routes/history-routes";
import { handleManualRefreshRoute } from "../routes/manual-refresh-routes";
import { handleProductRoute } from "../routes/product-routes";
import { handleSettingsRoute } from "../routes/settings-routes";
import { handleSubscriptionRoute } from "../routes/subscription-routes";
import type { AppDatabase } from "./database/types";
import { AuthRepository } from "../repositories/postgres/auth-repository";
import { DashboardRepository } from "../repositories/postgres/dashboard-repository";
import { ExportRepository } from "../repositories/postgres/export-repository";
import { HistoryRepository } from "../repositories/postgres/history-repository";
import { ManualRefreshRepository } from "../repositories/postgres/manual-refresh-repository";
import { PriceRepository } from "../repositories/postgres/price-repository";
import { CollectionRepository } from "../repositories/postgres/collection-repository";
import { ExchangeRateRepository } from "../repositories/postgres/exchange-rate-repository";
import { NotificationEventRepository } from "../repositories/postgres/notification-event-repository";
import { ProductHealthRepository } from "../repositories/postgres/product-health-repository";
import { RetentionRepository } from "../repositories/postgres/retention-repository";
import { SettingsRepository } from "../repositories/postgres/settings-repository";
import { SubscriptionDetailRepository } from "../repositories/postgres/subscription-detail-repository";
import { SubscriptionRepository } from "../repositories/postgres/subscription-repository";
import { SubscriptionConfirmationRepository } from "../repositories/postgres/subscription-confirmation-repository";
import { AuthService } from "../services/auth-service";
import { DashboardService } from "../services/dashboard-service";
import { ExportService } from "../services/export-service";
import { HistoryService } from "../services/history-service";
import { ManualRefreshService } from "../services/manual-refresh-service";
import { OfficialPriceIdService } from "../services/official-price-id-service";
import { ProductHealthService } from "../services/product-health-service";
import { RetentionService } from "../services/retention-service";
import { SettingsService } from "../services/settings-service";
import { SubscriptionDetailService } from "../services/subscription-detail-service";
import { SubscriptionService } from "../services/subscription-service";
import { createNintendoPriceApiProvider } from "../providers/official-nintendo-price-api";
import { defaultFallbackSources, SubscriptionPreviewService } from "../services/subscription-preview-service";
import { createOfficialProviderRegistry } from "../providers/official-provider-registry";
import { ProviderChain } from "../providers/provider-chain";
import { CollectionService } from "../services/collection-service";
import { DailyCnyRateService } from "../services/daily-cny-rate-service";
import { LiveCollectionRunner } from "../services/live-collection-runner";
import { createFrankfurterExchangeRateProvider } from "../providers/frankfurter-exchange-rate";
import { runPendingNotificationDelivery, runScheduled, runSixHourCollection } from "../services/scheduler-service";
import { ProxyTelegramService } from "../services/proxy-telegram-service";
import { createOutboundNetwork } from "./network/outbound-network";
import type { SchedulerDependencies } from "./scheduler";
import { createOfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import { createOfficialNintendoSearch } from "../providers/official-nintendo-search";
import { createOfficialJapaneseUpgradeRootSearch } from "../providers/official-japanese-upgrade-root";
import { createNintendoOfficialPriceQuoteResolver } from "../providers/official-nintendo-price-api";
import { createJapaneseUpgradeRelationService } from "../services/japanese-upgrade-relation-service";
import { createLocalBrowserLauncher } from "../providers/playwright/browser-launcher";
import { createJapaneseUpgradeBrowserBatch } from "../providers/playwright/japanese-upgrade-browser";
import { OfficialProductDiscoveryService } from "../services/official-product-discovery-service";
import { SubscriptionConfirmationService } from "../services/subscription-confirmation-service";
import { JapaneseSubscriptionConfirmationService } from "../services/japanese-subscription-confirmation-service";
import { SubscriptionRegionCompletionService } from "../services/subscription-region-completion-service";
import { ProxyConnectionTestService } from "../services/proxy-connection-test-service";
import { createProxyBrowserConnectionProbe } from "./network/proxy-browser-probe";
import { defaultProxySettings } from "../shared/proxy-settings";
import type { OutboundNetwork, OutboundNetworkSession } from "./network/outbound-network";

/** Node 装配所需的公开部署开关；Telegram 成对校验已在 config 层完成，路由不会读取环境对象。 */
export interface ServerDependencyOptions {
  cookieSecure: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
}

/**
 * 用 PostgreSQL 仓储组装当前已迁移的 HTTP 能力。所有业务路由仍使用同一 Fetch Request，
 * Task 7 完成本地 Chromium 适配后可在此处继续注入商品发现/确认服务，而不改变 Node HTTP 边界。
 */
export function createPostgresServerDependencies(database: AppDatabase, options: ServerDependencyOptions): ServerDependencies {
  const auth = new AuthService(new AuthRepository(database));
  const settingsRepository = new SettingsRepository(database);
  const settings = new SettingsService(settingsRepository);
  const outboundNetwork = createOutboundNetwork({ settings: settingsRepository });
  // 手动刷新也属于一次完整业务操作；只有在请求开始时读取代理快照，才不会继续沿用进程启动时的全局 fetch。
  const manualRefresh = {
    refresh: async (now: string) => {
      const session = await outboundNetwork.snapshot();
      return new ManualRefreshService(
        new ManualRefreshRepository(database),
        createLiveCollectionRunner(database, session.fetch.bind(session)),
      ).refresh(now);
    },
  };
  // 商品发现、来源预览和确认均在具体业务操作开始时创建代理快照；进程启动时不固定全局 fetch 或浏览器出口。
  const productServices = createProxyAwareProductServices(outboundNetwork, database, settingsRepository);
  return {
    async dispatchApi(request) {
      const authResponse = await handleAuthRoute(request, { auth, sessions: auth, cookieSecure: options.cookieSecure });
      if (authResponse) return authResponse;
      const settingsResponse = await handleSettingsRoute(request, {
        sessions: auth,
        settings,
        proxySupported: true,
        proxyTest: new ProxyConnectionTestService(
          outboundNetwork,
          createProxyBrowserConnectionProbe(createLocalBrowserLauncher({ headless: true })),
        ),
      });
      if (settingsResponse) return settingsResponse;
      const dashboardResponse = await handleDashboardRoute(request, { sessions: auth, dashboard: new DashboardService(new DashboardRepository(database)) });
      if (dashboardResponse) return dashboardResponse;
      const refreshResponse = await handleManualRefreshRoute(request, { sessions: auth, refresh: manualRefresh });
      if (refreshResponse) return refreshResponse;
      const historyResponse = await handleHistoryRoute(request, { sessions: auth, history: new HistoryService(new HistoryRepository(database)) });
      if (historyResponse) return historyResponse;
      const exportResponse = await handleExportRoute(request, { sessions: auth, exports: new ExportService(new ExportRepository(database)) });
      if (exportResponse) return exportResponse;
      const productResponse = await handleProductRoute(request, {
        sessions: auth,
        preview: productServices.preview,
        discovery: productServices.discovery,
        confirmation: productServices.confirmation,
      });
      if (productResponse) return productResponse;
      const subscriptionResponse = await handleSubscriptionRoute(request, {
        sessions: auth,
        subscriptions: new SubscriptionService(new SubscriptionRepository(database)),
        details: new SubscriptionDetailService(new SubscriptionDetailRepository(database)),
        completion: productServices.completion,
      });
      return subscriptionResponse;
    },
  };
}

/**
 * 将原 Worker Cron 的三条业务路径装配到 PostgreSQL advisory lock 调度器。
 * 每项任务只接收同一次 UTC 触发时刻；Telegram 未成对配置时传 undefined，既有服务会安全跳过消息读取或外部发送。
 */
export function createPostgresSchedulerDependencies(database: AppDatabase, options: ServerDependencyOptions): SchedulerDependencies {
  const settings = new SettingsRepository(database);
  const events = new NotificationEventRepository(database);
  // Node 调度器只创建统一出站网络实例；每次 Telegram 逻辑投递再由适配器获取一次不可变代理快照。
  const outboundNetwork = createOutboundNetwork({ settings });
  const telegram = options.telegramBotToken && options.telegramChatId
    ? new ProxyTelegramService({ botToken: options.telegramBotToken, chatId: options.telegramChatId }, outboundNetwork)
    : undefined;
  return {
    database,
    async runMinute(scheduledAt) {
      // 即时通知不等日报时刻；两条读取共享同一触发时刻但彼此独立，某条业务失败会由外层安全记录而不泄漏响应细节。
      await Promise.all([
        runPendingNotificationDelivery(scheduledAt, { events, marker: events, telegram }),
        runScheduled(scheduledAt, { settings, overview: new DashboardService(new DashboardRepository(database)), telegram }),
      ]);
    },
    async runSixHour(scheduledAt) {
      // 一轮六小时采集只读取一次代理设置；该会话同时服务汇率和所有官方价格 Provider，轮次内不会切换出口。
      const session = await outboundNetwork.snapshot();
      await runSixHourCollection(scheduledAt, {
        settings,
        retention: new RetentionService(new RetentionRepository(database)),
        collection: createLiveCollectionRunner(database, session.fetch.bind(session)),
      });
    },
    recordSafeFailure({ task, scheduledAt }) {
      // 日志只保留固定任务名和服务端 UTC 时刻；错误对象可能含数据库 URL、外部页面或 Telegram 返回正文，绝不序列化。
      console.error(`scheduler ${task} failed at ${scheduledAt}`);
    },
  };
}

/** 统一构造手动刷新与六小时任务共用的采集器，保证价格来源、汇率、健康状态和即时降价事件规则一致。 */
function createLiveCollectionRunner(database: AppDatabase, fetcher: typeof fetch = fetch): LiveCollectionRunner {
  const prices = new PriceRepository(database);
  return new LiveCollectionRunner({
    products: new CollectionRepository(database),
    rates: new DailyCnyRateService(createFrankfurterExchangeRateProvider(fetcher), new ExchangeRateRepository(database)),
    officialProviders: createOfficialProviderRegistry(fetcher),
    collection: new CollectionService(new ProviderChain(), prices),
    health: new ProductHealthService(new ProductHealthRepository(database), new NotificationEventRepository(database)),
    previousOfficial: prices,
    events: new NotificationEventRepository(database),
  });
}

/**
 * Node 商品业务的统一代理装配。
 * 每次搜索、链接确认、来源预览或地区补全都只调用一次 snapshot；同一次操作内部的搜索、详情、价格 API、日区根搜索和 Browser
 * 共享同一不可变代理端点，设置 PATCH 只能影响下一次操作。Worker/D1 不会调用该工厂，因此不会获得伪代理兼容层。
 */
function createProxyAwareProductServices(
  outbound: OutboundNetwork,
  database: AppDatabase,
  settingsRepository: SettingsRepository,
) {
  const makeRuntime = (session: OutboundNetworkSession) => {
    const fetcher = session.fetch.bind(session);
    const pages = createOfficialNintendoProductPageResolver(fetcher);
    const search = createOfficialNintendoSearch(fetcher);
    const officialPriceIds = new OfficialPriceIdService(createNintendoPriceApiProvider(fetcher));
    const relations = createJapaneseUpgradeRelationService(
      createOfficialJapaneseUpgradeRootSearch(fetcher),
      createJapaneseUpgradeBrowserBatch(createLocalBrowserLauncher({ headless: true }), {
        // Browser 复用本次 HTTP 操作的同一快照；测试替身没有该字段时显式使用关闭代理的安全默认值。
        readProxySettings: async () => ({ ...(session.proxySettings ?? defaultProxySettings) }),
      }),
      createNintendoOfficialPriceQuoteResolver(fetcher),
    );
    const discovery = new OfficialProductDiscoveryService(settingsRepository, search, pages, pages, relations);
    const preview = new SubscriptionPreviewService(officialPriceIds, defaultFallbackSources);
    const confirmation = new SubscriptionConfirmationService(
      new SubscriptionConfirmationRepository(database),
      pages,
      officialPriceIds,
      settingsRepository,
      new JapaneseSubscriptionConfirmationService(search, officialPriceIds),
      relations,
      discovery,
    );
    const completion = new SubscriptionRegionCompletionService(
      new SubscriptionConfirmationRepository(database),
      pages,
      officialPriceIds,
      settingsRepository,
      discovery,
    );
    return { preview, discovery, confirmation, completion };
  };

  const withRuntime = async <T>(operation: (runtime: ReturnType<typeof makeRuntime>) => Promise<T>): Promise<T> => {
    // snapshot 失败只向 HTTP 路由交给既有统一错误处理；这里不把设置、代理地址或底层数据库错误写入日志。
    const runtime = makeRuntime(await outbound.snapshot());
    return operation(runtime);
  };

  return {
    preview: {
      create: (candidates: Parameters<SubscriptionPreviewService["create"]>[0]) => withRuntime((runtime) => runtime.preview.create(candidates)),
    },
    discovery: {
      searchDefaultRegion: (query: Parameters<OfficialProductDiscoveryService["searchDefaultRegion"]>[0]) => withRuntime((runtime) => runtime.discovery.searchDefaultRegion(query)),
      resolveOfficialLink: (...args: Parameters<OfficialProductDiscoveryService["resolveOfficialLink"]>) => withRuntime((runtime) => runtime.discovery.resolveOfficialLink(...args)),
      resolveRegions: (candidates: Parameters<OfficialProductDiscoveryService["resolveRegions"]>[0]) => withRuntime((runtime) => runtime.discovery.resolveRegions(candidates)),
    },
    confirmation: {
      confirm: (...args: Parameters<SubscriptionConfirmationService["confirm"]>) => withRuntime((runtime) => runtime.confirmation.confirm(...args)),
    },
    completion: {
      resolveExisting: (subscriptionId: Parameters<SubscriptionRegionCompletionService["resolveExisting"]>[0]) => withRuntime((runtime) => runtime.completion.resolveExisting(subscriptionId)),
      completeExisting: (...args: Parameters<SubscriptionRegionCompletionService["completeExisting"]>) => withRuntime((runtime) => runtime.completion.completeExisting(...args)),
    },
  };
}
