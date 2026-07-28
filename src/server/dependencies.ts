import { createFrankfurterExchangeRateProvider } from "../providers/frankfurter-exchange-rate";
import { createNintendoPriceApiProvider } from "../providers/official-nintendo-price-api";
import { createOfficialNintendoProductPageResolver } from "../providers/official-nintendo-product-page";
import { createOfficialNintendoSearch } from "../providers/official-nintendo-search";
import { createOfficialProviderRegistry } from "../providers/official-provider-registry";
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
import type { JapaneseUpgradeRelationService } from "../services/japanese-upgrade-relation-service";
import { JapaneseSubscriptionConfirmationService } from "../services/japanese-subscription-confirmation-service";
import { LiveCollectionRunner } from "../services/live-collection-runner";
import { ManualRefreshService } from "../services/manual-refresh-service";
import { OfficialPriceIdService } from "../services/official-price-id-service";
import { OfficialProductDiscoveryService } from "../services/official-product-discovery-service";
import { ProductHealthService } from "../services/product-health-service";
import { SettingsService } from "../services/settings-service";
import { SubscriptionConfirmationService } from "../services/subscription-confirmation-service";
import { SubscriptionDetailService } from "../services/subscription-detail-service";
import { SubscriptionRegionCompletionService } from "../services/subscription-region-completion-service";
import { SubscriptionService } from "../services/subscription-service";
import { defaultFallbackSources, SubscriptionPreviewService } from "../services/subscription-preview-service";
import type { AppDatabase } from "./database/types";
import type { ServerDependencies } from "./app";
import type { ServerConfig } from "./config";

/** 单个 API handler 只消费标准同源 Request；null 表示本模块未匹配，不能被当成空成功响应。 */
export type ApiRouteHandler = (request: Request) => Promise<Response | null>;

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
  config: Pick<ServerConfig, "cookieSecure">,
): ServerDependencies {
  const auth = new AuthService(new PostgresAuthRepository(database));
  const settingsRepository = new PostgresSettingsRepository(database);
  const settings = new SettingsService(settingsRepository);
  const dashboard = new DashboardService(new PostgresDashboardRepository(database));
  const history = new HistoryService(new PostgresHistoryRepository(database));
  const exports = new ExportService(new PostgresExportRepository(database));
  const refresh = new ManualRefreshService(
    new PostgresManualRefreshRepository(database),
    createLiveCollectionRunner(database),
  );

  const officialPages = createOfficialNintendoProductPageResolver();
  const officialSearch = createOfficialNintendoSearch();
  const officialPriceIds = new OfficialPriceIdService(createNintendoPriceApiProvider());
  /**
   * Task 7 才会提供本地 Playwright。此处的窄占位对所有日区升级关系操作抛固定内部错误：
   * 不导入 Worker Browser Binding、不伪造候选，也不允许保存前复核绕过；路由会把异常转换为安全通用响应。
   */
  const japaneseUpgradeRelations = createUnavailableJapaneseUpgradeRelations();
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

  return {
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

/** Task 7 替换此错误与占位对象；固定错误不包含锚点 URL、官方响应、浏览器状态或运行时秘密。 */
class JapaneseUpgradeRelationsUnavailableError extends Error {
  public constructor() {
    super("NODE_JAPANESE_UPGRADE_RELATIONS_UNAVAILABLE");
  }
}

/** 任何关系入口都明确失败，避免未接入 Playwright 时返回可被误解为官方成功的空证据。 */
function createUnavailableJapaneseUpgradeRelations(): JapaneseUpgradeRelationService {
  return {
    async discover() {
      throw new JapaneseUpgradeRelationsUnavailableError();
    },
    async resolveManual() {
      throw new JapaneseUpgradeRelationsUnavailableError();
    },
    async verifyForConfirmation(items) {
      // 无升级包时返回空证据不会绕过验证；只有实际需要关系能力时才阻断普通商品订阅流程。
      if (items.length === 0) return new Map();
      throw new JapaneseUpgradeRelationsUnavailableError();
    },
  };
}
