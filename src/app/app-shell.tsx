import { useEffect, useState } from "react";

import { dashboardPath, readAppRoute, subscriptionNewPath, type AppRoute } from "./app-navigation";
import { createDashboardApiClient } from "./dashboard-api-client";
import { DashboardPage } from "./dashboard-page";
import { SubscriptionDetailPage } from "./subscription-detail-page";
import { SubscriptionWizardPage } from "./subscription-wizard-page";

/** 同源客户端不保存 Cookie，应用壳层可在页面切换间安全复用。 */
const dashboardApi = createDashboardApiClient();

/**
 * 已认证应用外壳统一管理 History API 和左侧导航。切换路由只改变当前页面组件，
 * 认证失效则由任意页面回调给根组件，从而一次性卸载所有管理员价格与订阅数据。
 */
export function AppShell({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [route, setRoute] = useState<AppRoute>(() => readAppRoute(window.location.pathname));

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
        <span>设置（即将提供）</span>
      </aside>
      <main className="monitor-main">
        {route.kind === "dashboard" ? <DashboardPage api={dashboardApi} onNavigate={navigate} onUnauthorized={onUnauthorized} /> : null}
        {route.kind === "subscription-new" ? <SubscriptionWizardPage onUnauthorized={onUnauthorized} /> : null}
        {route.kind === "subscription-detail" ? <SubscriptionDetailPage api={dashboardApi} subscriptionId={route.subscriptionId} onBack={() => navigate(dashboardPath())} onUnauthorized={onUnauthorized} /> : null}
      </main>
    </div>
  );
}
