/** 已认证页面的请求完成回调；订阅者只读取计数，不接触请求路径、Cookie 或错误内容。 */
export type ApiRequestListener = () => void;

/**
 * 计数式请求跟踪器是全局加载遮罩的唯一状态来源。
 * 同一时间可能存在搜索、设置保存和仪表盘重读等并发请求，因此不能由任一页面的布尔值提前隐藏遮罩。
 */
export interface ApiRequestTracker {
  /** 开始一次已认证同源请求，并返回只能安全执行一次的结束函数。 */
  begin(): () => void;
  /** 供 React 外部存储订阅；取消订阅后不能继续保留已卸载页面的回调。 */
  subscribe(listener: ApiRequestListener): () => void;
  /** 返回非负进行中请求数；不暴露请求内容，避免 UI 状态成为敏感信息通道。 */
  getPendingCount(): number;
}

/**
 * 创建一个只存在于已认证应用壳生命周期内的请求跟踪器。
 * `finish` 的幂等性防止网络异常、finally 与组件卸载等重复清理把计数减成负数，从而永久错误地隐藏或显示加载遮罩。
 */
export function createApiRequestTracker(): ApiRequestTracker {
  let pendingCount = 0;
  const listeners = new Set<ApiRequestListener>();

  /** 只发布“计数已变更”信号；每个订阅者自行读取数值，避免把请求细节分发到 React 树。 */
  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    begin(): () => void {
      pendingCount += 1;
      notify();
      let finished = false;

      return () => {
        if (finished) return;
        finished = true;
        pendingCount -= 1;
        notify();
      };
    },
    subscribe(listener: ApiRequestListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPendingCount(): number {
      return pendingCount;
    },
  };
}
