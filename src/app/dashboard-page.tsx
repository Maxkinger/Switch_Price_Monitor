import { useEffect, useState } from "react";

import { subscriptionDetailPath, subscriptionNewPath } from "./app-navigation";
import { DashboardApiError, type CompletedRefreshResult, type DashboardOverview } from "./dashboard-api-client";
import { immediateRefreshNotice } from "./dashboard-page-state";
import { formatCnyFen, formatDashboardDateTime, formatLocalPrice } from "./dashboard-view-model";
import { SubscriptionDeleteDialog } from "./subscription-delete-dialog";

/** 仪表盘仅要求客户端具备的读取/立即采集能力，保持页面可在测试中注入受控端口。 */
interface DashboardPageApi {
  getDashboard(): Promise<DashboardOverview>;
  refreshNow(): Promise<CompletedRefreshResult>;
  deleteSubscriptions(subscriptionIds: string[]): Promise<{ deletedSubscriptionIds: string[] }>;
}

/**
 * 概览优先首页。价格和状态完全来自 Worker；当前页面不请求任天堂、第三方站点、汇率服务或 Telegram，
 * 手动刷新只等待 Worker 侧统一采集；完成后重新读取仪表盘，防止浏览器自行合成价格或历史最低价。
 */
export function DashboardPage({ api, onNavigate, onUnauthorized }: { api: DashboardPageApi; onNavigate: (path: string) => void; onUnauthorized: () => void }) {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 选择状态仅存订阅 ID，不能复制价格或游戏对象；Worker 重读后才是唯一可信的展示数据来源。
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<Set<string>>(new Set());
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getDashboard().then((result) => { if (active) setOverview(result); }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof DashboardApiError ? error.message : "仪表盘暂时无法读取，请稍后重试。");
    });
    return () => { active = false; };
  }, [api, onUnauthorized]);

  async function refreshNow(): Promise<void> {
    setNotice(null);
    try {
      const result = await api.refreshNow();
      const refreshedOverview = await api.getDashboard();
      setOverview(refreshedOverview);
      setNotice(immediateRefreshNotice(result));
    }
    catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof DashboardApiError ? error.message : "刷新暂时无法完成。");
    }
  }

  /** 单张卡片的复选框只变更选择集合，不触发详情导航；可防止多选时误离开仪表盘并丢失当前选择。 */
  function toggleSubscriptionSelection(subscriptionId: string): void {
    setSelectedSubscriptionIds((current) => {
      const next = new Set(current);
      if (next.has(subscriptionId)) next.delete(subscriptionId);
      else next.add(subscriptionId);
      return next;
    });
  }

  /**
   * 第二次确认后才调用 Worker 硬删除。成功后不在浏览器裁剪概览，而是重新读取完整仪表盘；
   * 读取失败时清空旧概览以避免继续展示已经永久删除的价格或历史数据。
   */
  async function confirmDelete(): Promise<void> {
    const subscriptionIds = [...selectedSubscriptionIds];
    if (subscriptionIds.length === 0) return;

    setIsDeleting(true);
    setNotice(null);
    try {
      await api.deleteSubscriptions(subscriptionIds);
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else if (error instanceof DashboardApiError && error.status === 404) {
        setIsDeleteDialogOpen(false);
        setNotice("订阅已不存在，请重新确认。");
      } else setNotice(error instanceof DashboardApiError ? error.message : "订阅暂时无法删除，请稍后重试。");
      setIsDeleting(false);
      return;
    }

    setSelectedSubscriptionIds(new Set());
    setIsDeleteDialogOpen(false);
    try {
      setOverview(await api.getDashboard());
    } catch (error) {
      setOverview(null);
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof DashboardApiError ? error.message : "订阅已删除，但仪表盘暂时无法刷新。");
    } finally {
      setIsDeleting(false);
    }
  }

  if (!overview) return <p className="page-loading">正在读取仪表盘…</p>;
  return <section className="dashboard-page" aria-labelledby="dashboard-title">
    <header className="dashboard-header"><div><h1 id="dashboard-title">仪表盘</h1><p>查看当前价格与历史最低价。</p></div><div><button className="secondary-button" type="button" onClick={() => void refreshNow()}>立即刷新</button><button className="primary-button" type="button" onClick={() => onNavigate(subscriptionNewPath())}>添加订阅</button></div></header>
    <div className="dashboard-stats"><p><b>{overview.stats.monitoredSubscriptionCount}</b>正在监控商品</p><p><b>{overview.stats.availableRegionPriceCount}</b>可用地区价格</p><p>最近采集：{overview.stats.lastCapturedAt ? formatDashboardDateTime(overview.stats.lastCapturedAt, overview.stats.timezone ?? "UTC") : "暂无"}</p><p>下次日报：{overview.stats.nextDailyReportAt ? formatDashboardDateTime(overview.stats.nextDailyReportAt, overview.stats.timezone ?? "UTC") : "未设置"}</p></div>
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    {selectedSubscriptionIds.size > 0 ? <div className="dashboard-selection-toolbar"><span>已选择 {selectedSubscriptionIds.size} 个订阅</span><button className="danger-button" type="button" onClick={() => setIsDeleteDialogOpen(true)}>删除已选（{selectedSubscriptionIds.size}）</button></div> : null}
    {overview.subscriptions.length === 0 ? <section className="dashboard-empty"><h2>还没有订阅</h2><p>添加一款已核验的任天堂商品后，这里会显示五区价格和历史最低价。</p><button className="primary-button" type="button" onClick={() => onNavigate(subscriptionNewPath())}>添加订阅</button></section> : <div className="subscription-list">{overview.subscriptions.map((subscription) => <article className="subscription-summary" key={subscription.subscriptionId}><label className="subscription-summary__selection"><input type="checkbox" checked={selectedSubscriptionIds.has(subscription.subscriptionId)} onChange={() => toggleSubscriptionSelection(subscription.subscriptionId)} aria-label={`选择 ${subscription.nameZh}`} /><span>选择</span></label><button className="subscription-summary__details" type="button" onClick={() => onNavigate(subscriptionDetailPath(subscription.subscriptionId))}><header><h2>{subscription.nameZh}</h2><span>{subscription.enabled ? "监控中" : "已暂停"}</span></header><div className="summary-regions">{subscription.regions.map((region) => <p key={region.regionalProductId}><b>{region.regionCode}</b>{region.current ? <><span>{formatLocalPrice(region.current.amountMinor, region.currency)}</span><small>{formatCnyFen(region.current.cnyFen)} · {region.current.source}{region.isStale ? " · 过期" : ""}</small></> : <small>等待首笔价格</small>}</p>)}</div><footer>跨区历史最低：{subscription.allRegionHistoricalLow ? `${subscription.allRegionHistoricalLow.regionCode} ${formatLocalPrice(subscription.allRegionHistoricalLow.amountMinor, subscription.allRegionHistoricalLow.currency)}（${formatCnyFen(subscription.allRegionHistoricalLow.cnyFen)}）` : "暂无可比较记录"}</footer></button></article>)}</div>}
    {isDeleteDialogOpen ? <SubscriptionDeleteDialog subscriptionCount={selectedSubscriptionIds.size} isDeleting={isDeleting} onCancel={() => setIsDeleteDialogOpen(false)} onConfirm={() => void confirmDelete()} /> : null}
  </section>;
}
