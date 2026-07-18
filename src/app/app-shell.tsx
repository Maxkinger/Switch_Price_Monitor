import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { dashboardPath, readAppRoute, settingsPath, subscriptionNewPath, type AppRoute } from "./app-navigation";
import { createProductApiClient } from "./api-client";
import { createApiRequestTracker } from "./api-request-tracker";
import { createDashboardApiClient } from "./dashboard-api-client";
import { DashboardPage } from "./dashboard-page";
import { GlobalRequestOverlay } from "./global-request-overlay";
import { releaseVersion } from "./release-version";
import { createSettingsApiClient } from "./settings-api-client";
import { SettingsPage } from "./settings-page";
import { SubscriptionDetailPage } from "./subscription-detail-page";
import { SubscriptionWizardPage } from "./subscription-wizard-page";

/**
 * 已认证应用外壳统一管理 History API 和左侧导航。切换路由只改变当前页面组件，
 * 认证失效则由任意页面回调给根组件，从而一次性卸载所有管理员价格与订阅数据；同一壳还拥有唯一请求计数器，
 * 确保路由切换后仍由同一遮罩准确反映并发的同源管理员请求，而不记录任何请求内容或 Cookie。
 */
export function AppShell({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [route, setRoute] = useState<AppRoute>(() => readAppRoute(window.location.pathname));
  // 仅在本次已认证壳生命周期创建一次；认证失效卸载壳后计数与订阅回调一并释放，不能带到下一次登录。
  const [requestTracker] = useState(() => createApiRequestTracker());
  // 三类客户端共用 tracker，但仍按领域拆分 API 面，避免任一页面取得不需要的写入方法或外站访问能力。
  const dashboardApi = useMemo(() => createDashboardApiClient(fetch, requestTracker), [requestTracker]);
  const productApi = useMemo(() => createProductApiClient(fetch, requestTracker), [requestTracker]);
  const settingsApi = useMemo(() => createSettingsApiClient(fetch, requestTracker), [requestTracker]);
  // 外部存储订阅只读取非敏感数量；全局遮罩不展示路径、参数、错误或认证资料。
  const pendingRequestCount = useSyncExternalStore(requestTracker.subscribe, requestTracker.getPendingCount, requestTracker.getPendingCount);

  useEffect(() => {
    // 浏览器前进/返回必须恢复对应页面，不把详情状态塞进 URL 查询参数或本地存储。
    const handlePopState = () => setRoute(readAppRoute(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  /** 统一写入本站相对路径，避免导航函数接受外站 URL 而使已登录窗口跳转离开应用。 */
  function navigate(path: string): void {
    window.history.pushState(null, "", path);
    setRoute(readAppRoute(path));
  }

  return (
    <div className="monitor-app">
      <aside className="monitor-nav" aria-label="主导航">
        <strong>Switch Price Monitor</strong>
        <button type="button" className={route.kind === "dashboard" ? "monitor-nav__active" : ""} onClick={() => navigate(dashboardPath())}>仪表盘</button>
        <button type="button" className={route.kind === "subscription-new" ? "monitor-nav__active" : ""} onClick={() => navigate(subscriptionNewPath())}>添加订阅</button>
        <span>价格历史（即将提供）</span>
        <button type="button" className={route.kind === "settings" ? "monitor-nav__active" : ""} onClick={() => navigate(settingsPath())}>设置</button>
        {/* 版本位于导航末尾，仅展示构建时公开版本，不包含提交号、环境变量或凭据。 */}
        <small className="monitor-nav__version">V {releaseVersion}</small>
      </aside>
      <main className="monitor-main">
        {route.kind === "dashboard" ? <DashboardPage api={dashboardApi} onNavigate={navigate} onUnauthorized={onUnauthorized} /> : null}
        {route.kind === "subscription-new" ? <SubscriptionWizardPage api={productApi} onUnauthorized={onUnauthorized} /> : null}
        {route.kind === "subscription-detail" ? <SubscriptionDetailPage api={dashboardApi} productApi={productApi} subscriptionId={route.subscriptionId} onBack={() => navigate(dashboardPath())} onUnauthorized={onUnauthorized} /> : null}
        {route.kind === "settings" ? <SettingsPage api={settingsApi} onUnauthorized={onUnauthorized} /> : null}
      </main>
      <GlobalRequestOverlay visible={pendingRequestCount > 0} />
    </div>
  );
}
