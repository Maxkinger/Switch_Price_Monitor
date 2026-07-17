import { useEffect, useMemo, useState } from "react";

import { DashboardApiError, type CompletedRefreshResult, type SubscriptionDetail, type SubscriptionUpdate } from "./dashboard-api-client";
import { formatCnyFen, formatLocalPrice } from "./dashboard-view-model";
import { immediateRefreshNotice } from "./dashboard-page-state";

/** 详情页只依赖受控详情读取、立即采集和现有 PATCH 写入接口，商品确认仍需回到添加订阅流程。 */
interface DetailApi {
  getSubscription(id: string): Promise<SubscriptionDetail>;
  refreshNow(): Promise<CompletedRefreshResult>;
  updateSubscription(id: string, update: SubscriptionUpdate): Promise<unknown>;
}

/**
 * 单页订阅详情提供三个独立保存操作：启用状态、已确认地区范围和目标价。
 * 页面不接受商品 ID 文本输入；地区复选框只来自 Worker 返回的已确认映射，不能绕过官方核验流程。
 */
export function SubscriptionDetailPage({ api, subscriptionId, onBack, onUnauthorized }: { api: DetailApi; subscriptionId: string; onBack: () => void; onUnauthorized: () => void }) {
  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [globalTarget, setGlobalTarget] = useState("");
  const [regionalTargets, setRegionalTargets] = useState<Record<string, string>>({});
  const monitoredIds = useMemo(() => new Set(detail?.regions.filter((region) => region.monitored).map((region) => region.regionalProductId) ?? []), [detail]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  async function reload(): Promise<boolean> {
    try {
      const next = await api.getSubscription(subscriptionId);
      setDetail(next); setSelectedIds(new Set(next.regions.filter((region) => region.monitored).map((region) => region.regionalProductId)));
      setGlobalTarget(next.globalTargetCnyFen === null ? "" : String(next.globalTargetCnyFen));
      setRegionalTargets(Object.fromEntries(next.regionTargets.map((target) => [target.regionCode, String(target.targetAmountMinor)])));
      return true;
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else if (error instanceof DashboardApiError && error.status === 404) { onBack(); }
      else setNotice(error instanceof DashboardApiError ? error.message : "订阅详情暂时无法读取。");
      return false;
    }
  }

  useEffect(() => { void reload(); }, [subscriptionId]); // 订阅 ID 改变时重新读取，不能复用上一张卡片的价格与目标价。

  async function save(update: SubscriptionUpdate, success: string): Promise<void> {
    setNotice(null);
    try { await api.updateSubscription(subscriptionId, update); await reload(); setNotice(success); }
    catch (error) { if (error instanceof DashboardApiError && error.status === 401) onUnauthorized(); else setNotice(error instanceof DashboardApiError ? error.message : "保存未完成，请稍后重试。"); }
  }

  async function refreshNow(): Promise<void> {
    setNotice(null);
    try {
      const result = await api.refreshNow();
      // 只有详情重新读取成功时才提示本轮完成，避免认证失效或订阅删除后仍显示已更新的旧页面。
      if (await reload()) setNotice(immediateRefreshNotice(result));
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof DashboardApiError ? error.message : "刷新暂时无法完成。");
    }
  }

  if (!detail) return <p className="page-loading">正在读取订阅详情…</p>;
  return <section className="detail-page" aria-labelledby="detail-title">
    <button type="button" className="text-button" onClick={onBack}>← 返回仪表盘</button>
    <header className="detail-header"><div><h1 id="detail-title">{detail.game.nameZh}</h1><p>{detail.game.nameEn} · {detail.game.productType}</p></div><div><button className="secondary-button" type="button" onClick={() => void refreshNow()}>立即刷新</button><button className="primary-button" type="button" onClick={() => void save({ enabled: !detail.enabled }, detail.enabled ? "订阅已暂停。" : "订阅已启用。")}>{detail.enabled ? "暂停订阅" : "启用订阅"}</button></div></header>
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    <section><h2>地区价格</h2><div className="detail-regions">{detail.regions.map((region) => <article key={region.regionalProductId}><h3>{region.regionCode} · {region.currency}</h3>{region.current ? <p><b>{formatLocalPrice(region.current.amountMinor, region.currency)}</b><small>{formatCnyFen(region.current.cnyFen)} · {region.current.source} · {region.current.capturedAt}{region.isStale ? " · 过期" : ""}</small></p> : <p>等待首笔价格</p>}<small>地区历史最低：{region.historicalLow ? `${formatLocalPrice(region.historicalLow.amountMinor, region.currency)}（${formatCnyFen(region.historicalLow.cnyFen)}）` : "暂无"}</small></article>)}</div></section>
    <section className="detail-management"><h2>管理订阅</h2><fieldset><legend>监控地区</legend>{detail.regions.map((region) => <label key={region.regionalProductId}><input type="checkbox" checked={selectedIds.has(region.regionalProductId)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(region.regionalProductId)) next.delete(region.regionalProductId); else next.add(region.regionalProductId); return next; })} />{region.regionCode}（已确认商品）</label>)}<button className="secondary-button" type="button" disabled={selectedIds.size === 0 || [...selectedIds].every((id) => monitoredIds.has(id))} onClick={() => void save({ regionalProductIds: [...selectedIds] }, "监控地区已保存。")}>保存监控地区</button></fieldset>
    <fieldset><legend>目标价（最小货币单位）</legend><label>全局人民币分<input inputMode="numeric" value={globalTarget} onChange={(event) => setGlobalTarget(event.target.value)} placeholder="留空则不设置" /></label>{detail.regions.map((region) => <label key={region.regionCode}>{region.regionCode} 当地最小单位<input inputMode="numeric" value={regionalTargets[region.regionCode] ?? ""} onChange={(event) => setRegionalTargets((current) => ({ ...current, [region.regionCode]: event.target.value }))} placeholder="留空则不设置" /></label>)}<button className="secondary-button" type="button" onClick={() => { const regionTargets = Object.entries(regionalTargets).flatMap(([regionCode, value]) => /^\d+$/.test(value) && Number(value) > 0 ? [{ regionCode, targetAmountMinor: Number(value) }] : []); const globalTargetCnyFen = /^\d+$/.test(globalTarget) && Number(globalTarget) > 0 ? Number(globalTarget) : null; void save({ globalTargetCnyFen, regionTargets }, "目标价已保存。"); }}>保存目标价</button></fieldset></section>
  </section>;
}
