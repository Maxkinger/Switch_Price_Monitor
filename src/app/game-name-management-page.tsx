import { useCallback, useEffect, useState } from "react";

import {
  GameNameApiError,
  type GameNameBackfillResponse,
  type GameNameProductType,
  type PendingGameNameDto,
  type SaveGameNameInput,
} from "./game-name-api-client";

/** 管理页只取得队列、回填和单条写入能力；建议端点留给向导，不能把 Task 7 状态混入当前页面。 */
interface GameNameManagementApi {
  listPending(): Promise<{ games: PendingGameNameDto[] }>;
  backfill(): Promise<GameNameBackfillResponse>;
  saveGameName(gameId: string, input: SaveGameNameInput): Promise<unknown>;
}

/** 商品类型采用固定中文辅助标签；它只帮助管理员核对身份，绝不成为普通仪表盘或详情主标题。 */
const productTypeLabels: Record<GameNameProductType, string> = {
  game: "游戏本体",
  "upgrade-pack": "升级包",
  dlc: "DLC",
  "season-pass": "季票",
  bundle: "合集",
  other: "其他",
};

/**
 * 简体中文名称管理页独立拥有待补充队列、编辑草稿和回填状态。
 * 页面不读取仪表盘概览，也不复制价格或地区数组；每次写入成功都重新读取服务端队列作为唯一结果来源。
 */
export function GameNameManagementPage({ api, onUnauthorized }: { api: GameNameManagementApi; onUnauthorized: () => void }) {
  const [games, setGames] = useState<PendingGameNameDto[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  // 成功标记与 settled 分开，避免首次网络错误把默认空数组误报成“全部名称已补齐”。
  const [hasLoadedSuccessfully, setHasLoadedSuccessfully] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [catalogGameIds, setCatalogGameIds] = useState<Set<string>>(new Set());
  const [savingGameIds, setSavingGameIds] = useState<Set<string>>(new Set());
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * 队列重读保留仍存在行的管理员草稿，但只用 legacyNameZh 初始化首次出现的项；
   * 这样后台并发回填不会覆盖正在编辑的文本，历史候选也只有管理员点击保存后才会成为确认名称。
   */
  const reloadPending = useCallback(async (): Promise<boolean> => {
    try {
      const result = await api.listPending();
      setGames(result.games);
      setHasLoadedSuccessfully(true);
      setDrafts((current) => {
        const next: Record<string, string> = {};
        for (const game of result.games) next[game.gameId] = current[game.gameId] ?? game.legacyNameZh;
        return next;
      });
      setHasLoaded(true);
      return true;
    } catch (error) {
      setHasLoaded(true);
      if (error instanceof GameNameApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof GameNameApiError ? error.message : "待补充名称暂时无法读取，请稍后重试。");
      return false;
    }
  }, [api, onUnauthorized]);

  useEffect(() => {
    void reloadPending();
  }, [reloadPending]);

  /** 目录回填结果只用于成功摘要；实际剩余行必须通过 reloadPending 重读，不能按 updatedGameIds 在本地裁剪。 */
  async function backfill(): Promise<void> {
    setIsBackfilling(true);
    setNotice(null);
    try {
      const result = await api.backfill();
      if (await reloadPending()) setNotice(`目录回填完成：更新 ${result.updatedGameIds.length} 款，剩余 ${result.remainingCount} 款待补充。`);
    } catch (error) {
      if (error instanceof GameNameApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof GameNameApiError ? error.message : "目录回填暂时无法完成，请稍后重试。");
    } finally {
      setIsBackfilling(false);
    }
  }

  /**
   * 单条保存固定使用 manual 来源且不伪造公开证据；空白也交由 Task 4 返回稳定 422，
   * 失败时不清空 drafts，成功后只通过服务端重读移除或更新该行。
   */
  async function saveGameName(gameId: string): Promise<void> {
    setSavingGameIds((current) => new Set(current).add(gameId));
    setNotice(null);
    try {
      await api.saveGameName(gameId, {
        displayNameZhCn: drafts[gameId] ?? "",
        source: "manual",
        evidenceUrl: null,
        saveToCatalog: catalogGameIds.has(gameId),
      });
      if (await reloadPending()) setNotice("中文名称已保存。");
    } catch (error) {
      if (error instanceof GameNameApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof GameNameApiError ? error.message : "中文名称暂时无法保存，请稍后重试。");
    } finally {
      setSavingGameIds((current) => {
        const next = new Set(current);
        next.delete(gameId);
        return next;
      });
    }
  }

  /** 复用选择按 gameId 独立保存；它只影响下一次该行提交，不会批量提升其他历史候选。 */
  function toggleCatalog(gameId: string): void {
    setCatalogGameIds((current) => {
      const next = new Set(current);
      if (next.has(gameId)) next.delete(gameId);
      else next.add(gameId);
      return next;
    });
  }

  return <section className="game-name-page" aria-labelledby="game-name-title">
    <header className="game-name-header">
      <div><h1 id="game-name-title">中文名称管理</h1><p>核对官方商品身份后，补充用于仪表盘和详情页的简体中文显示名称。</p></div>
      <button className="secondary-button" type="button" disabled={isBackfilling} onClick={() => void backfill()}>{isBackfilling ? "回填中…" : "执行目录回填"}</button>
    </header>
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    <section className="game-name-queue" aria-labelledby="pending-game-name-title">
      <div className="game-name-queue__heading"><div><h2 id="pending-game-name-title">待补充中文名称</h2><p>官方标题、发行商和类型仅用于管理员核对，不会替代已确认中文名。</p></div>{hasLoadedSuccessfully ? <span>{games.length} 款待处理</span> : null}</div>
      {!hasLoaded ? <p className="page-loading">正在读取待补充名称…</p> : null}
      {/* 成功摘要与空队列是两个独立事实；回填/保存完成后应同时告诉管理员发生了什么以及已无待处理项。 */}
      {hasLoadedSuccessfully && games.length === 0 ? <p className="game-name-empty">所有游戏都已有简体中文名称。</p> : null}
      <div className="game-name-list">{games.map((game) => <article className="game-name-card" key={game.gameId}>
        <header><div><h3>{game.officialTitle}</h3><p><span>{game.publisher ?? "发行商未提供"}</span><span>{productTypeLabels[game.productType]}</span></p></div><small>{game.identityKey === null ? "缺少精确官方身份" : "官方身份已核对"}</small></header>
        <div className="game-name-card__form">
          <label><span>简体中文显示名称</span><input value={drafts[game.gameId] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [game.gameId]: event.target.value }))} /></label>
          <label className="game-name-catalog-choice"><input type="checkbox" checked={catalogGameIds.has(game.gameId)} onChange={() => toggleCatalog(game.gameId)} />保存为可复用词条</label>
          <button className="primary-button" type="button" disabled={savingGameIds.has(game.gameId) || game.identityKey === null} onClick={() => void saveGameName(game.gameId)}>{savingGameIds.has(game.gameId) ? "保存中…" : "保存中文名称"}</button>
        </div>
      </article>)}</div>
    </section>
  </section>;
}
