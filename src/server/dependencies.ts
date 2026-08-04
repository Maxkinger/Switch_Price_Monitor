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
  const settings = new SettingsService(new SettingsRepository(database));
  const prices = new PriceRepository(database);
  const collection = new LiveCollectionRunner({
    products: new CollectionRepository(database),
    rates: new DailyCnyRateService(createFrankfurterExchangeRateProvider(), new ExchangeRateRepository(database)),
    officialProviders: createOfficialProviderRegistry(),
    collection: new CollectionService(new ProviderChain(), prices),
    health: new ProductHealthService(new ProductHealthRepository(database), new NotificationEventRepository(database)),
    previousOfficial: prices,
    events: new NotificationEventRepository(database),
  });
  const preview = new SubscriptionPreviewService(new OfficialPriceIdService(createNintendoPriceApiProvider()), defaultFallbackSources);
  return {
    async dispatchApi(request) {
      const authResponse = await handleAuthRoute(request, { auth, sessions: auth, cookieSecure: options.cookieSecure });
      if (authResponse) return authResponse;
      const settingsResponse = await handleSettingsRoute(request, { sessions: auth, settings });
      if (settingsResponse) return settingsResponse;
      const dashboardResponse = await handleDashboardRoute(request, { sessions: auth, dashboard: new DashboardService(new DashboardRepository(database)) });
      if (dashboardResponse) return dashboardResponse;
      const refreshResponse = await handleManualRefreshRoute(request, { sessions: auth, refresh: new ManualRefreshService(new ManualRefreshRepository(database), collection) });
      if (refreshResponse) return refreshResponse;
      const historyResponse = await handleHistoryRoute(request, { sessions: auth, history: new HistoryService(new HistoryRepository(database)) });
      if (historyResponse) return historyResponse;
      const exportResponse = await handleExportRoute(request, { sessions: auth, exports: new ExportService(new ExportRepository(database)) });
      if (exportResponse) return exportResponse;
      const productResponse = await handleProductRoute(request, { sessions: auth, preview });
      if (productResponse) return productResponse;
      const subscriptionResponse = await handleSubscriptionRoute(request, {
        sessions: auth,
        subscriptions: new SubscriptionService(new SubscriptionRepository(database)),
        details: new SubscriptionDetailService(new SubscriptionDetailRepository(database)),
      });
      return subscriptionResponse;
    },
  };
}
