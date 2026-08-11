import { useCallback, useEffect, useRef, useState } from "react";

import {
  GameNameApiError,
  type AiGameNameSuggestion,
  type GameNameBackfillResponse,
  type GameNameProductType,
  type GameNameSuggestionCandidate,
  type PendingGameNameDto,
  type SaveGameNameInput,
} from "./game-name-api-client";

/** 管理页只取得队列、回填、单条写入和按需建议能力；AI 端点只返回草稿，不能扩大保存合同。 */
interface GameNameManagementApi {
  listPending(): Promise<{ games: PendingGameNameDto[] }>;
  backfill(): Promise<GameNameBackfillResponse>;
  suggestAiNames(candidates: GameNameSuggestionCandidate[]): Promise<{ suggestions: AiGameNameSuggestion[] }>;
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
  // AI 请求按 gameId 独立追踪，避免一行网络较慢时冻结管理员对其他游戏的核对或保存操作。
  const [suggestingGameIds, setSuggestingGameIds] = useState<Set<string>>(new Set());
  // 标记仅表示当前输入值来自尚未确认的 AI 草稿；人工再次编辑即撤销，绝不暗示数据已经写入。
  const [aiSuggestedGameIds, setAiSuggestedGameIds] = useState<Set<string>>(new Set());
  /**
   * 仅记录本次页面会话内被管理员碰过的草稿；ref 让迟到请求在结算时读取最新意图，
   * 从而区分“初始本为空，可预填”和“原有名称被明确清空，必须保留空值”两种相同文本状态。
   */
  const editedDraftGameIds = useRef<Set<string>>(new Set());
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

  /**
   * 向 AI 端点仅发送当前行的公开官方身份，并以 gameId 关联回应，避免标题重复时错填另一条待处理游戏。
   * 迟到响应只能覆盖从未被编辑的初始 legacyNameZh 或初始空草稿；管理员主动清空也属于编辑意图。
   * 此操作只更新 React 草稿和“待确认”标识，从不调用 saveGameName，因此 AI 永远不能绕过管理员最终保存。
   */
  async function suggestAiName(game: PendingGameNameDto): Promise<void> {
    setSuggestingGameIds((current) => new Set(current).add(game.gameId));
    setNotice(null);
    try {
      const response = await api.suggestAiNames([{
        candidateKey: game.gameId,
        canonicalTitle: game.officialTitle,
        publisher: game.publisher,
        productType: game.productType,
      }]);
      const suggestion = response.suggestions.find((entry) => entry.candidateKey === game.gameId)?.displayNameZhCn;
      if (suggestion === null || suggestion === undefined) return;
      setDrafts((current) => {
        const draft = current[game.gameId] ?? "";
        // ref 记录点击后发生的编辑，避免延迟网络响应把管理员主动清空的旧名称误判为“初始为空”。
        if (editedDraftGameIds.current.has(game.gameId) || (draft !== game.legacyNameZh && draft !== "")) return current;
        setAiSuggestedGameIds((ids) => new Set(ids).add(game.gameId));
        return { ...current, [game.gameId]: suggestion };
      });
    } catch (error) {
      // 认证失效必须让外层壳卸载旧管理页；503、超时与网络错误只显示服务端脱敏摘要，按钮随后可重试。
      if (error instanceof GameNameApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof GameNameApiError ? error.message : "AI 名称建议暂时无法读取，请稍后重试。");
    } finally {
      setSuggestingGameIds((current) => {
        const next = new Set(current);
        next.delete(game.gameId);
        return next;
      });
    }
  }

  /** 人工输入立即记为编辑意图并取消 AI 来源标记，确保清空与普通修改都不会被迟到模型结果覆盖。 */
  function updateDraft(gameId: string, value: string): void {
    editedDraftGameIds.current.add(gameId);
    setDrafts((current) => ({ ...current, [gameId]: value }));
    setAiSuggestedGameIds((current) => {
      if (!current.has(gameId)) return current;
      const next = new Set(current);
      next.delete(gameId);
      return next;
    });
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
          <label><span>简体中文显示名称</span><input value={drafts[game.gameId] ?? ""} onChange={(event) => updateDraft(game.gameId, event.target.value)} />{aiSuggestedGameIds.has(game.gameId) ? <small className="game-name-ai-marker">AI 建议，待确认</small> : null}</label>
          <label className="game-name-catalog-choice"><input type="checkbox" checked={catalogGameIds.has(game.gameId)} onChange={() => toggleCatalog(game.gameId)} />保存为可复用词条</label>
          <button className="secondary-button game-name-ai-button" type="button" disabled={suggestingGameIds.has(game.gameId)} onClick={() => void suggestAiName(game)}>{suggestingGameIds.has(game.gameId) ? "生成中…" : "生成 AI 建议"}</button>
          <button className="primary-button" type="button" disabled={savingGameIds.has(game.gameId) || game.identityKey === null} onClick={() => void saveGameName(game.gameId)}>{savingGameIds.has(game.gameId) ? "保存中…" : "保存中文名称"}</button>
        </div>
      </article>)}</div>
    </section>
  </section>;
}
