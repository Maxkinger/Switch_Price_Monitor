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
import { PostgresCollectionRepository } from "../repositories/postgres/collection-repository";
import { PostgresDashboardRepository } from "../repositories/postgres/dashboard-repository";
import { PostgresExchangeRateRepository } from "../repositories/postgres/exchange-rate-repository";
import { PostgresExportRepository } from "../repositories/postgres/export-repository";
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
import { handleDashboardRoute } from "../routes/dashboard-routes";
import { handleExportRoute } from "../routes/export-routes";
import { handleHistoryRoute } from "../routes/history-routes";
import { handleManualRefreshRoute } from "../routes/manual-refresh-routes";
import { handleProductRoute } from "../routes/product-routes";
import { handleSettingsRoute } from "../routes/settings-routes";
import { handleSubscriptionRoute } from "../routes/subscription-routes";
import { AuthService } from "../services/auth-service";
import { CollectionService } from "../services/collection-service";
import { DailyCnyRateService } from "../services/daily-cny-rate-service";
import { DashboardService } from "../services/dashboard-service";
import { ExportService } from "../services/export-service";
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
import { TelegramService } from "../services/telegram-service";
import type { AppDatabase } from "./database/types";
import type { ServerDependencies } from "./app";
import type { ServerConfig } from "./config";
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
 * 不传入连接串、pg 客户端、process.env 或 Telegram 凭据；所有 API 顺序与迁移期 Worker 保持一致。
 */
export function createServerDependencies(
  database: AppDatabase,
  config: Pick<
    ServerConfig,
    "cookieSecure" | "telegramBotToken" | "telegramChatId"
  >,
): NodeServerDependencies {
  if (
    (config.telegramBotToken === undefined)
    !== (config.telegramChatId === undefined)
  ) {
    // 配置解析通常已保证成对；装配层仍独立拒绝半套凭据，错误码不插入 token 或 chat id。
    throw new Error("SCHEDULER_TELEGRAM_CREDENTIALS_INCOMPLETE");
  }
  const auth = new AuthService(new PostgresAuthRepository(database));
  const settingsRepository = new PostgresSettingsRepository(database);
  const settings = new SettingsService(settingsRepository);
  const dashboardRepository = new PostgresDashboardRepository(database);
  const dashboard = new DashboardService(dashboardRepository);
  const history = new HistoryService(new PostgresHistoryRepository(database));
  const exports = new ExportService(new PostgresExportRepository(database));
  /**
   * 同一个无状态 LiveCollectionRunner 同时交给手动刷新与六小时调度。
   * 两条入口仍由 HTTP 认证和 advisory lock 分别控制，绝不共享手动刷新时间记录或形成待执行队列。
   */
  const liveCollection = createLiveCollectionRunner(database);
  const refresh = new ManualRefreshService(
    new PostgresManualRefreshRepository(database),
    liveCollection,
  );

  const officialPages = createOfficialNintendoProductPageResolver();
  const officialSearch = createOfficialNintendoSearch();
  const officialPriceIds = new OfficialPriceIdService(createNintendoPriceApiProvider());
  /**
   * Node 商品发现与保存前确认共享同一套本地关系依赖：每次实际批处理只启动一个 Chromium，
   * 最多三个根使用全新上下文串行核验。浏览器 launcher 不接收数据库、Telegram、HTTP 或调度器对象。
   */
  const japaneseUpgradeRelations = createJapaneseUpgradeRelationService(
    createOfficialJapaneseUpgradeRootSearch(),
    createJapaneseUpgradeBrowserBatch(
      createLocalBrowserLauncher({ headless: true }),
    ),
    createNintendoOfficialPriceQuoteResolver(),
  );
  const discovery = new OfficialProductDiscoveryService(
    settingsRepository,
    officialSearch,
    officialPages,
    officialPages,
    japaneseUpgradeRelations,
  );
  const confirmationRepository = new PostgresSubscriptionConfirmationRepository(database);
  const confirmation = new SubscriptionConfirmationService(
    confirmationRepository,
    officialPages,
    officialPriceIds,
    settingsRepository,
    new JapaneseSubscriptionConfirmationService(officialSearch, officialPriceIds),
    japaneseUpgradeRelations,
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
        sessions: auth,
        // Cookie Secure 只由启动配置决定；任何 Forwarded 请求头都不会参与此值。
        cookieSecure: config.cookieSecure,
      }),
      (request) => handleSettingsRoute(request, auth, settings),
      (request) => handleDashboardRoute(request, auth, dashboard),
      (request) => handleManualRefreshRoute(request, auth, refresh),
      (request) => handleHistoryRoute(request, auth, history),
      (request) => handleExportRoute(request, auth, exports),
      (request) => handleProductRoute(
        request,
        auth,
        new SubscriptionPreviewService(officialPriceIds, defaultFallbackSources),
        discovery,
        confirmation,
      ),
      (request) => handleSubscriptionRoute(
        request,
        auth,
        subscriptions,
        details,
        completion,
      ),
    ]),
  };
  const notificationEvents = new PostgresNotificationEventRepository(database);
  const telegram = config.telegramBotToken === undefined
    ? undefined
    : new TelegramService({
      botToken: config.telegramBotToken,
      // 成对检查后 chat id 必然存在；不使用空字符串回退，避免把配置错误发送到外部 API。
      chatId: config.telegramChatId as string,
    });
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
function createLiveCollectionRunner(database: AppDatabase): LiveCollectionRunner {
  const prices = new PostgresPriceRepository(database);
  const rates = new PostgresExchangeRateRepository(database);
  const notifications = new PostgresNotificationEventRepository(database);
  return new LiveCollectionRunner({
    products: new PostgresCollectionRepository(database),
    rates: new DailyCnyRateService(createFrankfurterExchangeRateProvider(), rates),
    officialProviders: createOfficialProviderRegistry(),
    collection: new CollectionService(new ProviderChain(), prices),
    health: new ProductHealthService(
      new PostgresProductHealthRepository(database),
      notifications,
    ),
    previousOfficial: prices,
    events: notifications,
  });
}
