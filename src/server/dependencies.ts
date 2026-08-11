import { createFrankfurterExchangeRateProvider } from "../providers/frankfurter-exchange-rate";
import {
  createNintendoOfficialPriceQuoteResolver,
  createNintendoPriceApiProvider,
} from "../providers/official-nintendo-price-api";
import { createOfficialJapaneseUpgradeRootSearch } from "../providers/official-japanese-upgrade-root";
import { createOfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import { createOfficialNintendoSearch } from "../providers/official-nintendo-search";
import { createOfficialProviderRegistry } from "../providers/official-provider-registry";
import { createLocalBrowserLauncher } from "../providers/playwright/browser-launcher";
import { createJapaneseUpgradeBrowserBatch } from "../providers/playwright/japanese-upgrade-browser";
import { ProviderChain } from "../providers/provider-chain";
import { PostgresAuthRepository } from "../repositories/postgres/auth-repository";
import { PostgresAiProviderConfigurationRepository } from "../repositories/postgres/ai-provider-configuration-repository";
import { PostgresCollectionRepository } from "../repositories/postgres/collection-repository";
import { PostgresDashboardRepository } from "../repositories/postgres/dashboard-repository";
import { PostgresExchangeRateRepository } from "../repositories/postgres/exchange-rate-repository";
import { PostgresExportRepository } from "../repositories/postgres/export-repository";
import { PostgresGameNameRepository } from "../repositories/postgres/game-name-repository";
import { PostgresHistoryRepository } from "../repositories/postgres/history-repository";
import { PostgresManualRefreshRepository } from "../repositories/postgres/manual-refresh-repository";
import { PostgresNotificationEventRepository } from "../repositories/postgres/notification-event-repository";
import { PostgresPriceRepository } from "../repositories/postgres/price-repository";
import { PostgresProductHealthRepository } from "../repositories/postgres/product-health-repository";
import { PostgresRetentionRepository } from "../repositories/postgres/retention-repository";
import { PostgresSettingsRepository } from "../repositories/postgres/settings-repository";
import { PostgresSubscriptionConfirmationRepository } from "../repositories/postgres/subscription-confirmation-repository";
import { PostgresSubscriptionDetailRepository } from "../repositories/postgres/subscription-detail-repository";
import { PostgresSubscriptionRepository } from "../repositories/postgres/subscription-repository";
import { handleAuthRoute } from "../routes/auth-routes";
import { handleAiProviderSettingsRoute } from "../routes/ai-provider-settings-routes";
import { handleDashboardRoute } from "../routes/dashboard-routes";
import { handleExportRoute } from "../routes/export-routes";
import { handleGameNameRoute } from "../routes/game-name-routes";
import { handleHistoryRoute } from "../routes/history-routes";
import { handleManualRefreshRoute } from "../routes/manual-refresh-routes";
import { handleProductRoute } from "../routes/product-routes";
import { handleSettingsRoute } from "../routes/settings-routes";
import { handleSubscriptionRoute } from "../routes/subscription-routes";
import { AuthService } from "../services/auth-service";
import { AiProviderConfigurationService } from "../services/ai-provider-configuration-service";
import { CollectionService } from "../services/collection-service";
import { DailyCnyRateService } from "../services/daily-cny-rate-service";
import { DeepSeekGameNameSuggestionService } from "../services/deepseek-game-name-suggestion-service";
import { DashboardService } from "../services/dashboard-service";
import { ExportService } from "../services/export-service";
import { GameNameService } from "../services/game-name-service";
import { HistoryService } from "../services/history-service";
import { createJapaneseUpgradeRelationService } from "../services/japanese-upgrade-relation-service";
import { JapaneseSubscriptionConfirmationService } from "../services/japanese-subscription-confirmation-service";
import { LiveCollectionRunner } from "../services/live-collection-runner";
import { ManualRefreshService } from "../services/manual-refresh-service";
import { OfficialPriceIdService } from "../services/official-price-id-service";
import { OfficialProductDiscoveryService } from "../services/official-product-discovery-service";
import { ProductHealthService } from "../services/product-health-service";
import { RetentionService } from "../services/retention-service";
import {
  runPendingNotificationDelivery,
  runScheduled,
  runSixHourCollection,
} from "../services/scheduler-service";
import { SettingsService } from "../services/settings-service";
import { SubscriptionConfirmationService } from "../services/subscription-confirmation-service";
import { SubscriptionDetailService } from "../services/subscription-detail-service";
import { SubscriptionRegionCompletionService } from "../services/subscription-region-completion-service";
import { SubscriptionService } from "../services/subscription-service";
import { defaultFallbackSources, SubscriptionPreviewService } from "../services/subscription-preview-service";
import { ProxyConnectionTestService } from "../services/proxy-connection-test-service";
import { ProxyTelegramService } from "../services/proxy-telegram-service";
import { defaultProxySettings } from "../shared/proxy-settings";
import type { AppDatabase } from "./database/types";
import type { ServerDependencies } from "./app";
import type { ServerConfig } from "./config";
import { createOutboundNetwork } from "./network/outbound-network";
import { createProxyBrowserConnectionProbe } from "./network/proxy-browser-probe";
import type { SchedulerDependencies } from "./scheduler";

/** 单个 API handler 只消费标准同源 Request；null 表示本模块未匹配，不能被当成空成功响应。 */
export type ApiRouteHandler = (request: Request) => Promise<Response | null>;

/**
 * Node 进程装配同时拥有 HTTP 与调度边界；两者共享数据库和采集器，但 HTTP 路由无法直接启动定时任务，
 * 调度器也不能取得 Cookie、Request 或完整运行环境。
 */
export interface NodeServerDependencies {
  http: ServerDependencies;
  scheduler: SchedulerDependencies;
}

/**
 * 按输入顺序复用同一个 Request 分发，首个非 null Response 立即结束。
 * 该小函数把路由优先级变成可测试的运行时契约，避免 Node 入口复制正文后使认证或 JSON 解析看到不同请求。
 */
export function createApiDispatcher(
  handlers: readonly ApiRouteHandler[],
): ServerDependencies["dispatchApi"] {
  return async (request) => {
    for (const handler of handlers) {
      const response = await handler(request);
      if (response !== null) return response;
    }
    return null;
  };
}

/**
 * Node 入口只在此处把一个 AppDatabase 装配为 PostgreSQL 仓储、平台中立服务与既有路由。
 * 不传入连接串、pg 客户端、process.env 或 Telegram 凭据；所有 API 顺序由当前 Node 同源入口统一维护。
 */
export function createServerDependencies(
  database: AppDatabase,
  config: Pick<
    ServerConfig,
    "cookieSecure" | "telegramBotToken" | "telegramChatId"
  > & Partial<Pick<ServerConfig, "localDevelopmentAuthBypass" | "aiCredentialEncryptionKey">>,
): NodeServerDependencies {
  if (
    (config.telegramBotToken === undefined)
    !== (config.telegramChatId === undefined)
  ) {
    // 配置解析通常已保证成对；装配层仍独立拒绝半套凭据，错误码不插入 token 或 chat id。
    throw new Error("SCHEDULER_TELEGRAM_CREDENTIALS_INCOMPLETE");
  }
  const auth = new AuthService(new PostgresAuthRepository(database));
  /**
   * 旁路替身只在已校验的本机开发配置为 true 时产生，且不读取、创建或伪造 Cookie/会话。
   * 默认仍将真实 AuthService 交给所有管理路由，因此生产、NAS 与未设置变量的本机进程不会失去认证保护。
   */
  const routeSessions = config.localDevelopmentAuthBypass
    ? { authenticate: async (): Promise<boolean> => true }
    : auth;
  const settingsRepository = new PostgresSettingsRepository(database);
  const settings = new SettingsService(settingsRepository);
  /** 代理唯一真值是 PostgreSQL 设置；读取异常安全退回关闭状态，不能因设置读取失败阻断业务。 */
  const outboundNetwork = createOutboundNetwork({ settings: { async readProxySettings() {
    try { return { ...((await settingsRepository.get())?.proxy ?? defaultProxySettings) }; }
    catch { return { ...defaultProxySettings }; }
  } } });
  /** 每次外部 HTTP 请求先取得会话快照，提供方不能自行读取代理地址或绕过一次回退规则。 */
  const outboundFetch: typeof fetch = async (input, init) => (await (await outboundNetwork.snapshot()).fetch(input, init));
  const dashboardRepository = new PostgresDashboardRepository(database);
  const dashboard = new DashboardService(dashboardRepository);
  const history = new HistoryService(new PostgresHistoryRepository(database));
  const exports = new ExportService(new PostgresExportRepository(database));
  /**
   * 同一个无状态 LiveCollectionRunner 同时交给手动刷新与六小时调度。
   * 两条入口仍由 HTTP 认证和 advisory lock 分别控制，绝不共享手动刷新时间记录或形成待执行队列。
   */
  const liveCollection = createLiveCollectionRunner(database, outboundFetch);
  const refresh = new ManualRefreshService(
    new PostgresManualRefreshRepository(database),
    liveCollection,
  );

  const officialPages = createOfficialNintendoProductPageResolver(outboundFetch);
  const officialSearch = createOfficialNintendoSearch(outboundFetch);
  const officialPriceIds = new OfficialPriceIdService(createNintendoPriceApiProvider(outboundFetch));
  /**
   * Node 商品发现与保存前确认共享同一套本地关系依赖：每次实际批处理只启动一个 Chromium，
   * 最多三个根使用全新上下文串行核验。浏览器 launcher 不接收数据库、Telegram、HTTP 或调度器对象。
   */
  // 同一个窄 launcher 只由 Node 装配拥有：关系核验读取一次设置快照，连接测试则只探测固定官方目标。
  const browserLauncher = createLocalBrowserLauncher({ headless: true });
  const japaneseUpgradeRelations = createJapaneseUpgradeRelationService(
    createOfficialJapaneseUpgradeRootSearch(outboundFetch),
    createJapaneseUpgradeBrowserBatch(
      browserLauncher,
      { readProxySettings: async () => (await settingsRepository.get())?.proxy ?? defaultProxySettings },
    ),
    createNintendoOfficialPriceQuoteResolver(outboundFetch),
  );
  const discovery = new OfficialProductDiscoveryService(
    settingsRepository,
    officialSearch,
    officialPages,
    officialPages,
    japaneseUpgradeRelations,
  );
  const confirmationRepository = new PostgresSubscriptionConfirmationRepository(database);
  // 同一名称服务实例负责确认阶段的精确词条决议；后续名称管理路由也必须复用该实例，避免不同仓储或优先级造成展示状态分叉。
  const gameNames = new GameNameService(new PostgresGameNameRepository(database));
  /**
   * AI 密文服务始终装配但仅在每次请求成功解密后外发；主密钥未配置或配置被删除时只返回固定未配置状态，
   * 不会在启动期缓存 Key，也不会改变名称仍须人工确认才写库的业务边界。
   */
  const aiProviderConfiguration = new AiProviderConfigurationService(
    new PostgresAiProviderConfigurationRepository(database),
    config.aiCredentialEncryptionKey,
  );
  const aiGameNameSuggestions = new DeepSeekGameNameSuggestionService(aiProviderConfiguration, outboundFetch);
  const confirmation = new SubscriptionConfirmationService(
    confirmationRepository,
    officialPages,
    officialPriceIds,
    settingsRepository,
    new JapaneseSubscriptionConfirmationService(officialSearch, officialPriceIds),
    japaneseUpgradeRelations,
    gameNames,
    discovery,
  );
  const subscriptions = new SubscriptionService(new PostgresSubscriptionRepository(database));
  const details = new SubscriptionDetailService(new PostgresSubscriptionDetailRepository(database));
  const completion = new SubscriptionRegionCompletionService(
    confirmationRepository,
    officialPages,
    officialPriceIds,
    settingsRepository,
    discovery,
  );

  const http: ServerDependencies = {
    dispatchApi: createApiDispatcher([
      (request) => handleAuthRoute(request, {
        auth,
        sessions: routeSessions,
        // Cookie Secure 只由启动配置决定；任何 Forwarded 请求头都不会参与此值。
        cookieSecure: config.cookieSecure,
        localDevelopmentAuthBypass: config.localDevelopmentAuthBypass,
      }),
      // 认证旁路只替换 sessions；代理设置仍经同一严格路由校验，不能因本机开发而放宽无认证端点边界。
      (request) => handleSettingsRoute(
        request,
        routeSessions,
        settings,
        true,
        new ProxyConnectionTestService(outboundNetwork, createProxyBrowserConnectionProbe(browserLauncher)),
      ),
      // AI Key 专用端点在普通设置之前精确匹配；两者都复用同一会话守卫，但此端点绝不混入公开 AppSettings DTO。
      (request) => handleAiProviderSettingsRoute(request, routeSessions, aiProviderConfiguration),
      (request) => handleDashboardRoute(request, routeSessions, dashboard),
      /**
       * 名称管理在正式环境继续直接校验真实 AuthService；仅已验证的本机旁路配置才把同一受限标志传给路由。
       * 该标志与 Node 入口的 127.0.0.1 强制监听成对存在，使本机回填/更正可测试，同时不允许 Docker、NAS 或请求参数继承匿名写权限。
       */
      (request) => handleGameNameRoute(
        request,
        auth,
        gameNames,
        // 仅显式 true 可触发回环开发旁路；生产仍把真实 AuthService 交给名称路由完成严格 session 验证。
        config.localDevelopmentAuthBypass === true,
        aiGameNameSuggestions,
      ),
      (request) => handleManualRefreshRoute(request, routeSessions, refresh),
      (request) => handleHistoryRoute(request, routeSessions, history),
      (request) => handleExportRoute(request, routeSessions, exports),
      (request) => handleProductRoute(
        request,
        routeSessions,
        new SubscriptionPreviewService(officialPriceIds, defaultFallbackSources),
        discovery,
        confirmation,
      ),
      (request) => handleSubscriptionRoute(
        request,
        routeSessions,
        subscriptions,
        details,
        completion,
      ),
    ]),
  };
  const notificationEvents = new PostgresNotificationEventRepository(database);
  const telegram = config.telegramBotToken === undefined
    ? undefined
    : new ProxyTelegramService({
      botToken: config.telegramBotToken,
      // 成对检查后 chat id 必然存在；不使用空字符串回退，避免把配置错误发送到外部 API。
      chatId: config.telegramChatId as string,
    }, outboundNetwork);
  const scheduler: SchedulerDependencies = {
    database,
    async runMinute(scheduledAt): Promise<void> {
      /**
       * 两条分钟路径并发启动并收到完全相同的 ISO；日报失败不能阻止 pending 通知开始重试，
       * 任一路径异常由外层调度器统一转换为不含 Error 的安全失败事件。
       */
      const results = await Promise.allSettled([
        runScheduled(scheduledAt, {
          settings: settingsRepository,
          overview: dashboardRepository,
          telegram,
        }),
        runPendingNotificationDelivery(scheduledAt, {
          events: notificationEvents,
          marker: notificationEvents,
          telegram,
        }),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        /**
         * 必须在两条路径全部 settle 后才让 advisory-lock 回调失败，避免日报先失败时提前释放锁，
         * 让仍在投递的 pending 与下一分钟重复执行。固定错误不保留 cause/reason，原数据库或网络异常
         * 不得越过装配边界进入日志、调度失败事件或测试快照。
         */
        throw new Error("SCHEDULER_MINUTE_TASK_FAILED");
      }
    },
    async runSixHour(scheduledAt): Promise<void> {
      // 既有组合服务已经固定“先保留、后一次采集”顺序；装配层不得再重复调用任一子步骤。
      await runSixHourCollection(scheduledAt, {
        settings: settingsRepository,
        retention: new RetentionService(
          new PostgresRetentionRepository(database),
        ),
        collection: liveCollection,
      });
    },
    recordSafeFailure(input): void {
      // 只记录固定摘要、任务枚举和已捕获 UTC；不接收 Error、SQL、URL、价格正文或 Telegram 响应。
      console.error("Node 定时任务执行失败。", input);
    },
  };
  return { http, scheduler };
}

/**
 * 手动刷新继续复用真实 PostgreSQL 价格、汇率、健康与通知事件写入。
 * 仓储只接收领域 DTO 与参数化 SQL，外部页面、错误正文和秘密不会写入普通运行日志。
 */
function createLiveCollectionRunner(database: AppDatabase, fetcher: typeof fetch): LiveCollectionRunner {
  const prices = new PostgresPriceRepository(database);
  const rates = new PostgresExchangeRateRepository(database);
  const notifications = new PostgresNotificationEventRepository(database);
  return new LiveCollectionRunner({
    products: new PostgresCollectionRepository(database),
    rates: new DailyCnyRateService(createFrankfurterExchangeRateProvider(fetcher), rates),
    officialProviders: createOfficialProviderRegistry(fetcher),
    collection: new CollectionService(new ProviderChain(), prices),
    health: new ProductHealthService(
      new PostgresProductHealthRepository(database),
      notifications,
    ),
    previousOfficial: prices,
    events: notifications,
  });
}
